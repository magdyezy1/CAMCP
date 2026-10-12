import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {assertAccountWrite} from './write-access.js';
import {metaCurrencyOffset} from './budget-units.js';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {storedLogin} from './connection-authority.js';
import {MirrorError} from './errors.js';

const gateway = 'meta_native_action';
const changed = (message: string): never => bad(message, 'ALLOCATION_BUDGET_CHANGED');
/** DEC-02: a budget ownership AMCP does not bind (lifetime, mixed, split, shared or unknown) is refused, never guessed. */
const unqualified = (message: string, details: JsonObject = {}): never =>
  bad(message, 'ALLOCATION_BUDGET_MODE', details);
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);

/** A Meta budget amount: an exact nonnegative integer in the account currency's minor unit, or null when absent. */
function nativeMoney(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return changed('Retain exact nonnegative Meta budget amounts in the account currency’s minor unit.');
}
const positive = (value: bigint | null) => value !== null && value > 0n;
/**
 * Who owns a Meta campaign's budget, from its current fields: the campaign (Advantage campaign budget: a daily or
 * lifetime budget on the campaign) or its ad sets (no campaign budget). Both at once is `mixed`.
 */
export function metaCampaignBudgetMode(campaign: JsonObject) {
  const daily = positive(nativeMoney(campaign.daily_budget)),
    lifetime = positive(nativeMoney(campaign.lifetime_budget));
  return daily && lifetime ? 'mixed' : daily ? 'campaign_daily' : lifetime ? 'campaign_lifetime' : 'ad_set';
}
/** Ad sets that can spend: Meta keeps deleted and archived ones listed, but they never deliver. */
const spendingAdSet = (adset: JsonObject) => !['DELETED', 'ARCHIVED'].includes(adset.status);

/**
 * DEC-02 Meta budget binding: bracketed exact reads of the account and each selected campaign with its ad sets.
 * A campaign with a daily campaign budget (Advantage campaign budget) is bound to that budget; a campaign without one
 * whose budget sits on exactly one spending ad set with a daily budget is bound to that ad set. Lifetime budgets, a
 * campaign and ad-set budget at once, ad-set budgets split across several ad sets, reserved buying and anything
 * malformed are refused. Amounts stay exact Meta minor units; micros are local bookkeeping with the pinned currency
 * offset. Never an atomic account snapshot.
 */
export async function metaAllocationBudgets(
  store: Store,
  call: ToolCall,
  actor: Actor,
  source: JsonObject,
  ids: string[],
) {
  const account = String(source.account_id ?? '').replace(/^act_/, '');
  if (
    !nativeId(account) ||
    typeof source.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(source.currency) ||
    typeof source.timezone !== 'string' ||
    !ids.length ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length ||
    ids.some(id => !nativeId(id))
  )
    changed('Select at most 20 exact Meta campaign IDs from this account’s verified report.');
  const offset = metaCurrencyOffset(source.currency);
  if (offset === undefined)
    bad(
      'Meta budgets count in the account currency’s minor unit, and AMCP has no pinned Meta offset for this currency. Pin Meta’s currency table before converting an allocation; nothing was read or saved.',
      'ALLOCATION_PRECISION',
      {currency: source.currency},
    );
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
      assertAccountWrite(store, c, account);
      if (authority(c) !== authorization)
        bad('The selected login changed. Preview the allocation again.', 'CONNECTION_AUTHORITY_CHANGED');
    },
    bound = new ReportCollectionBudget(undefined, fingerprint({account, ids}), () => {}, {
      requests: 300,
      rows: 22100,
      bytes: 8 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    references: JsonObject[] = [];
  const read = async (action: string, path_params: JsonObject, fields: string[], query: JsonObject = {}) => {
    current();
    const args = {
        action,
        account_id: account,
        connection_id: connection.id,
        path_params,
        query: {fields: fields.join(','), ...query},
        aggregate_pages: false,
        dry_run: false,
      },
      requested_at = Date.now(),
      response = await call(gateway, args, actor);
    current();
    if (!response.success)
      bad(
        response.error?.message ?? 'Current Meta budgets could not be read.',
        response.error?.code ?? 'ALLOCATION_BUDGET_UNAVAILABLE',
      );
    const d = response.data?.data;
    if (
      response.data?.truncated ||
      !obj(d) ||
      d.error !== undefined ||
      Buffer.byteLength(JSON.stringify(d), 'utf8') > 262144
    )
      changed('Meta returned failed, incomplete or oversized budget evidence.');
    references.push({source_request: args, source_hash: fingerprint(d), requested_at, captured_at: Date.now()});
    return d as JsonObject;
  };
  const micros = (native: bigint) => String((native * 1000000n) / BigInt(offset!));
  /**
   * Observes each wanted ID in the account's own collection (bounded pages), which is also the ownership evidence the
   * native scope guard needs before an object is read or changed by its ID.
   */
  const establish = async (collection: 'campaigns' | 'adsets', wanted: string[]) => {
    const missing = new Set(wanted),
      cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 1; page <= 100 && missing.size; page++) {
      const d = await read(
        collection === 'campaigns' ? 'meta_ad_account_id_campaigns_get' : 'meta_ad_account_id_adsets_get',
        {ad_account_id: account},
        collection === 'campaigns' ? ['id', 'account_id'] : ['id', 'account_id', 'campaign_id'],
        {limit: 100, ...(after ? {after} : {})},
      );
      if (!Array.isArray(d.data) || d.data.length > 100 || (d.paging !== undefined && !obj(d.paging)))
        changed('Meta returned a malformed account collection.');
      bound.rows(collection + '-' + page, d.data.length);
      for (const row of d.data as JsonObject[]) {
        if (!obj(row) || !nativeId(row.id)) changed('Meta returned a malformed account collection.');
        if (row.account_id !== undefined && row.account_id !== account)
          changed('Meta returned an object from another account.');
        missing.delete(row.id);
      }
      const next = d.paging?.cursors?.after;
      if (!missing.size || d.paging?.next === undefined) break;
      if (typeof next !== 'string' || !next || cursors.has(next) || page === 100)
        changed('Meta ownership lookup repeated or exceeded its bounded pages.');
      cursors.add(next);
      after = next;
    }
    if (missing.size) changed('Every selected Meta object must be observed in this account’s own collection.');
  };
  const accountState = async () => {
    const row = await read('meta_ad_account_id_get', {ad_account_id: account}, [
      'id',
      'account_id',
      'currency',
      'timezone_name',
      'account_status',
    ]);
    if (
      row.id !== 'act_' + account ||
      (row.account_id !== undefined && row.account_id !== account) ||
      row.currency !== source.currency ||
      row.timezone_name !== source.timezone ||
      Number(row.account_status) !== 1
    )
      changed('Use an active Meta account with the exact report identity, currency and time zone.');
    return {id: account, currency: row.currency, timezone: row.timezone_name, account_status: 1};
  };
  const campaignState = async (id: string) => {
    const row = await read('meta_campaign_id_get', {campaign_id: id}, [
      'id',
      'account_id',
      'name',
      'status',
      'buying_type',
      'daily_budget',
      'lifetime_budget',
      'spend_cap',
      'is_adset_budget_sharing_enabled',
    ]);
    if (
      row.id !== id ||
      row.account_id !== account ||
      !['ACTIVE', 'PAUSED'].includes(row.status) ||
      (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 1000))
    )
      changed('Use an owned active or paused Meta campaign in the report account.');
    if (row.buying_type !== 'AUCTION')
      unqualified('Only auction Meta campaigns qualify; reserved buying needs its own planning flow.', {
        campaign_id: id,
        buying_type: row.buying_type ?? null,
      });
    const listing = await read(
      'meta_campaign_id_adsets_get',
      {campaign_id: id},
      ['id', 'account_id', 'campaign_id', 'status', 'daily_budget', 'lifetime_budget'],
      {limit: 100},
    );
    if (
      !Array.isArray(listing.data) ||
      listing.data.length > 100 ||
      (listing.paging !== undefined && !obj(listing.paging)) ||
      listing.paging?.next !== undefined
    )
      unqualified(
        'This Meta campaign has more ad sets than one bounded read covers; its budget ownership is unknown.',
        {
          campaign_id: id,
        },
      );
    bound.rows('adsets-' + references.length, listing.data.length);
    const seen = new Set<string>();
    const adsets = (listing.data as JsonObject[]).map(adset => {
      if (!obj(adset) || !nativeId(adset.id) || seen.has(adset.id) || adset.campaign_id !== id)
        changed('Meta returned a malformed, repeated or foreign ad set.');
      if (adset.account_id !== undefined && adset.account_id !== account)
        changed('Meta returned an ad set from another account.');
      seen.add(adset.id);
      return {
        id: adset.id,
        status: String(adset.status ?? ''),
        daily_budget: nativeMoney(adset.daily_budget),
        lifetime_budget: nativeMoney(adset.lifetime_budget),
      };
    });
    const spending = adsets.filter(spendingAdSet),
      withBudget = spending.filter(a => positive(a.daily_budget) || positive(a.lifetime_budget));
    let mode = metaCampaignBudgetMode(row);
    // The campaign owns the budget, yet an ad set reports its own: Meta's ownership is ambiguous here.
    if (mode !== 'ad_set' && withBudget.length) mode = 'mixed';
    const daily = nativeMoney(row.daily_budget);
    const state: JsonObject = {
      id,
      name: row.name ?? null,
      account_id: account,
      status: row.status,
      buying_type: row.buying_type,
      mode,
      daily_budget: daily === null ? null : String(daily),
      lifetime_budget: row.lifetime_budget == null ? null : String(nativeMoney(row.lifetime_budget)),
      spend_cap: row.spend_cap == null ? null : String(nativeMoney(row.spend_cap)),
      adset_budget_sharing:
        typeof row.is_adset_budget_sharing_enabled === 'boolean' ? row.is_adset_budget_sharing_enabled : null,
      adsets: adsets.map(a => ({
        id: a.id,
        status: a.status,
        daily_budget: a.daily_budget === null ? null : String(a.daily_budget),
        lifetime_budget: a.lifetime_budget === null ? null : String(a.lifetime_budget),
      })),
    };
    if (mode === 'campaign_daily') return {...state, owner: 'campaign', native_daily: String(daily)};
    if (mode === 'campaign_lifetime')
      unqualified('This Meta campaign has a lifetime campaign budget; lifetime budgets need their own planning flow.', {
        campaign_id: id,
      });
    if (mode === 'mixed')
      unqualified(
        'This Meta campaign reports a campaign budget and ad-set budgets at once; its budget ownership is ambiguous.',
        {
          campaign_id: id,
        },
      );
    // Ad-set budgets: exactly one spending ad set may own the whole campaign's budget, as a daily budget.
    if (withBudget.length !== 1 || spending.length !== 1)
      unqualified(
        'This Meta campaign keeps its budget on several ad sets (or none). Allocating between ad sets needs ad-set evidence; no budget was chosen for you.',
        {campaign_id: id, spending_adsets: spending.length},
      );
    const owner = withBudget[0]!;
    if (!positive(owner.daily_budget) || positive(owner.lifetime_budget))
      unqualified(
        'The ad set that owns this Meta campaign’s budget uses a lifetime budget; it needs its own planning flow.',
        {
          campaign_id: id,
          adset_id: owner.id,
        },
      );
    return {...state, owner: 'ad_set', adset_id: owner.id, native_daily: String(owner.daily_budget)};
  };
  try {
    return await bound.run(async () => {
      const accountBefore = await accountState(),
        campaigns: JsonObject[] = [];
      await establish('campaigns', ids);
      for (const id of ids) campaigns.push(await campaignState(id));
      // The ad sets that own a budget are changed by their own IDs later, so their ownership is observed too.
      const owners = campaigns.filter(c => c.owner === 'ad_set').map(c => c.adset_id as string);
      if (owners.length) await establish('adsets', owners);
      for (const campaign of campaigns) {
        let again: JsonObject;
        try {
          again = await campaignState(campaign.id);
        } catch (e) {
          // A budget mode that stops qualifying between the two observations is a change, not a new refusal.
          if (e instanceof MirrorError && e.code === 'ALLOCATION_BUDGET_MODE')
            changed('Meta budget ownership changed during allocation inspection. Preview again.');
          throw e;
        }
        if (fingerprint(again) !== fingerprint(campaign))
          changed('Meta campaign or ad-set budgets changed during allocation inspection. Preview again.');
      }
      if (fingerprint(await accountState()) !== fingerprint(accountBefore))
        changed('Meta account metadata changed during allocation inspection. Preview again.');
      current();
      const targets = campaigns.map(campaign => {
        const {native_daily, ...observed} = campaign,
          state = {
            entity_id: campaign.id,
            campaign_id: campaign.id,
            budget_owner: campaign.owner,
            ...(campaign.owner === 'ad_set' ? {adset_id: campaign.adset_id} : {}),
            budget_resource: campaign.owner === 'ad_set' ? campaign.adset_id : campaign.id,
            amount_micros: micros(BigInt(native_daily)),
            native_daily_budget: native_daily,
            currency: source.currency,
            timezone: source.timezone,
            currency_offset: offset,
            campaign: observed,
            account: accountBefore,
          };
        return {...state, native_signature: fingerprint(state)};
      });
      return {targets, source_references: references};
    });
  } finally {
    bound.close();
  }
}
