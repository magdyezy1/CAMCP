import type {CompiledRequest, JsonObject} from './types.js';
import {budgetUnits, currencyMinorDigits, exactAmount} from './budget-units.js';
import {accountRecord, declaredOperation, listedIds, targetRecord} from './write-effects.js';
import {providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';

/**
 * A one-line, server-authored summary of a reviewed write (WRT-05 Stage E), shown above the exact native table, which
 * stays the authority: what the request does (operation, how many of which entity), on which account (its name and
 * currency when the review read them), the money it sets converted through the budget-unit contract with exact
 * decimals, and the status changes it makes. Values are never rounded and never guessed: an amount is converted only
 * where the platform's unit is documented and the field names its unit; otherwise it stays native.
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const money = /budget|bid|amount|spend_cap|cpc|cpm|target_cpa/i;
/** Money and status entries a summary lists; the exact request below holds every one. */
export const summaryEntries = 10;
const statusKeys = new Set(['status', 'entity_status', 'entityStatus', 'configured_status', 'operation_status']);
const singular: Record<string, string> = {
  campaigns: 'campaign',
  adsquads: 'ad squad',
  ads: 'ad',
  creatives: 'creative',
  adsets: 'ad set',
  adcreatives: 'ad creative',
  segments: 'segment',
  line_items: 'line item',
  lineItems: 'line item',
  insertionOrders: 'insertion order',
  adGroups: 'ad group',
  adgroup: 'ad group',
  campaign: 'campaign',
  ad: 'ad',
};
/** The same table by lower-case name: a platform that capitalizes its collections (Microsoft's `Campaigns`) names the same entities. */
const singularByName = new Map(Object.entries(singular).map(([name, entity]) => [name.toLowerCase(), entity]));
const singularOf = (segment: string): string | undefined => singularByName.get(segment.toLowerCase());
/**
 * What a route that ends in the id of the object it edits edits, where the table above names no collection of it (R2.5 r25-approval-fields, the
 * owner's friction report B6: a Meta ad set update read "Update 1 456 in account 111"): the collection before the id (LinkedIn's `adCampaigns` is
 * an "ad campaign"), or, for a route that is the id alone (Meta's `/v26.0/456`), the name of its action (`meta_ad_set_id_update` is an "ad set").
 */
function nodeEntity(plan: CompiledRequest, segments: string[]): string | undefined {
  if (!/\d/.test(segments.at(-1)?.replace(/:.*/, '') ?? '')) return undefined;
  const before = segments.at(-2) ?? '';
  // A collection that carries its API version (LinkedIn's adCampaignsV2) is named without it; the version segment itself names nothing.
  if (/[a-z]/i.test(before) && !/^v\d/i.test(before))
    return before
      .replace(/V\d+$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .toLowerCase()
      .replace(/(?<=[^s])s$/, '');
  return /^[a-z0-9]+_(.+?)_id_[a-z]+$/.exec(plan.action)?.[1]?.replaceAll('_', ' ');
}
// exactAmount, the exact decimal of a native amount, is src/budget-units.ts's since r25-approval-fields (the approval reads it too, and may not import this module).
export {exactAmount};
// accountRecord and holds, which find the account a review read and what it holds, are src/write-effects.ts's since r25-field3-livefix (item 3): the
// effects skip the account's record when they pick the target they name, as the summary does.
/** The account a review read, as name and currency. */
function accountOf(state: unknown[]): {name?: string; currency?: string} {
  const record = accountRecord(state);
  if (!record) return {};
  const name = record.descriptiveName ?? record.descriptive_name ?? record.name,
    currency = record.currency ?? record.currencyCode ?? record.currency_code;
  return {
    ...(typeof name === 'string' && name.length <= 200 ? {name} : {}),
    ...(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? {currency} : {}),
  };
}
/** The account currency a review's state read names, if any (WRT-07: currency-bound spending caps). */
export function stateCurrency(state: unknown): string | undefined {
  return accountOf(Array.isArray(state) ? state : [state]).currency;
}
/**
 * The thing a route creates when its last segment is the verb create, or undefined when it is not one. A REST route
 * names its collection last (POST /v1/adaccounts/1/campaigns), so its path shape says what it does; an RPC route names
 * the verb last (POST /v1.3/campaign/create/), or a verb and its noun (…/create-brand-account), or calls a custom
 * method on a resource (…/workspaces/3:create_version). The collection test never matched those, so every such create
 * read as an update, and the update then took a current status from the account read (R2.5 T3, owner 2026-11-15: the
 * approver must see the real operation). Only creation is read from the verb: any other verb keeps the words it had.
 */
function createdThing(segments: string[]): {noun?: string} | undefined {
  const last = segments.at(-1) ?? '';
  if (/^create$/i.test(last)) return {noun: segments.at(-2)};
  const named = /^create-([^/]+)$/i.exec(last) ?? /:create_([^/:]+)$/i.exec(last);
  return named ? {noun: named[1]} : undefined;
}
/**
 * Whether a POST writes into the collection directly under the account its provider declares for the reads of such a
 * create (LinkedIn's …/adAccounts/1/adCampaigns, X's …/accounts/1/promoted_tweets, Snapchat's …/adaccounts/1/media),
 * whatever the collection is called: the shape the review's own state reads call a collection create, since they read the
 * account for it (src/write-snapshots.ts). The account itself and a member of a collection are not under it.
 */
function underAccount(plan: CompiledRequest): boolean {
  const account = providerHooks(plan.gateway)?.writes?.accountPath?.exec(plan.path)?.[0];
  return (
    plan.method === 'POST' &&
    account !== undefined &&
    plan.path.slice(account.length).split('/').filter(Boolean).length === 1
  );
}
/**
 * Whether the request names a method other than a plain create, in a header (LinkedIn's Rest.li method on any POST,
 * X-HTTP-Method-Override) or in the query string a REST server reads (the keys the compiler recognizes as tunnels). A POST
 * to a collection that says BATCH_PARTIAL_UPDATE updates what it names whatever its path looks like, so a path alone must
 * not make it a create: that summary would hide an update, and its status, from the person approving it (R2.5 T3).
 */
function namesOtherMethod(plan: CompiledRequest): boolean {
  // A value is read as the compiler reads an override (String(value)), so a query value of ['PUT'] names PUT too.
  const other = (v: unknown) => v !== undefined && !/^(?:POST|CREATE|BATCH_CREATE)$/i.test(String(v).trim());
  return (
    Object.entries(plan.headers ?? {}).some(([name, value]) => /method/i.test(name) && other(value)) ||
    ['method', '_method', 'http_method', 'method_override'].some(key => other(plan.query?.[key]))
  );
}
// declaredOperation, what the review's own side declares the write does, is src/write-effects.ts's since r25-field3-livefix (item 3): the effects ask it too.

/** What the request does: an operation and the entities it acts on (also asked by the guard against a repeated create). */
export function operationOf(plan: CompiledRequest): {
  operation: string;
  entity: string;
  count: number;
  plural?: string;
} {
  const body = plan.body as unknown;
  // A provider whose writes name their operations themselves summarizes them (Google Ads' :mutate operations).
  const provided = providerOf(plan.gateway)?.reviewOperations;
  if (provided) return provided.summarize(plan);
  const segments = plan.path.split('/').filter(Boolean),
    collection = [...segments].reverse().find(s => Object.hasOwn(singular, s.replace(/:.*/, ''))) ?? '',
    key = collection.replace(/:.*/, ''),
    // The collection of the table that the route spells in another case (Apple's adgroups, Microsoft's Campaigns) names the entity too, and
    // the records its body lists under that spelling are the ones counted (R2.5 r25-approval-fields, B6).
    named = key
      ? undefined
      : [...segments]
          .reverse()
          .map(s => s.replace(/:.*/, ''))
          .find(s => singularOf(s) !== undefined),
    listed = object(body) && named !== undefined && Array.isArray(body[named]) ? body[named].length : 0,
    rows =
      object(body) && Array.isArray(body[key])
        ? body[key].length
        : Array.isArray(body)
          ? 1
          : (listedIds(plan) ?? (listed || 1)),
    // A verb is read only on a POST, as every route of the ledger that ends in one is: a PUT or a PATCH to an object whose
    // ID is the word create is an update of it, and so is a POST that names another method (R2.5 S4-1: one guard for every
    // way a path can read as a create). The noun stays the route's either way: it is what the request acts on.
    thing = plan.method === 'POST' ? createdThing(segments) : undefined,
    verb = thing && !namesOtherMethod(plan) ? thing : undefined;
  const action = plan.action.toLowerCase(),
    deletes = plan.method === 'DELETE' || /(?:^|_)delete(?:_|$)/.test(action) || plan.destructive,
    // A deletion stays what the method or the destructive flag says, whatever a family declares: that is `operation` below. How many it deletes
    // and what they are called are the declaration's all the same (r25-field3-livefix, item 3: four campaigns read "Delete 1 campaign" and a
    // negative keyword's deletion "Delete 1 delete", because a deletion took no declaration at all).
    declared = declaredOperation(plan);
  const operation = deletes
    ? 'delete'
    : /:publish$/.test(plan.path)
      ? 'publish'
      : declared
        ? // A request that names another method is no create, however it is declared (the one guard of every path).
          declared.operation === 'create' && namesOtherMethod(plan)
          ? 'update'
          : declared.operation
        : verb ||
            (/(?:^|_)(?:create|post)(?:_|$)/.test(action) &&
              (segments.at(-1) === key || underAccount(plan)) &&
              !namesOtherMethod(plan))
          ? 'create'
          : 'update';
  // A create names what it creates: a known collection anywhere in the path, else the noun before its verb, never the verb.
  return {
    operation,
    entity:
      declared?.entity ??
      singular[key] ??
      (named === undefined ? undefined : singularOf(named)) ??
      (key || thing?.noun?.replace(/[-_]+/g, ' ') || nodeEntity(plan, segments) || segments.at(-1) || 'resource'),
    count:
      declared?.count !== undefined && Number.isSafeInteger(declared.count) && declared.count >= 1
        ? declared.count
        : rows,
    ...(declared?.plural ? {plural: declared.plural} : {}),
  };
}
export function reviewSummary(plan: CompiledRequest, state: unknown[]): JsonObject {
  const {operation, entity, count, plural} = operationOf(plan),
    account = accountOf(state),
    unit = budgetUnits[plan.gateway],
    // A current status is named only for a single existing target: the first record read is not every target's, and the
    // account's read, which most reviews make first, is no target at all unless the request writes the account itself (a
    // path that is its provider's account path and nothing after it). Skipping it can only leave a "from" out, never show
    // another entity's status as the current one (R2.5 S3-1).
    target = operation === 'create' || count !== 1 ? undefined : targetRecord(plan, state);
  const amounts: JsonObject[] = [],
    statuses: JsonObject[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 12) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '/' + i, depth + 1));
    else if (object(v))
      for (const [k, x] of Object.entries(v)) {
        if (object(x) && Object.hasOwn(x, '$ref')) continue;
        if (statusKeys.has(k) && typeof x === 'string')
          statuses.push({
            field: path + '/' + k,
            ...(target?.status && target.status !== x ? {from: target.status} : {}),
            to: x,
          });
        else if (
          money.test(k) &&
          (typeof x === 'string' || typeof x === 'number') &&
          /^-?\d+(?:\.\d+)?$/.test(String(x))
        ) {
          const converts = unit && (unit.perCurrencyUnit === 1 || /micro/i.test(k));
          const amount = converts
            ? exactAmount(x, unit!.perCurrencyUnit, currencyMinorDigits(account.currency) ?? 2)
            : undefined;
          amounts.push({
            field: path + '/' + k,
            native: x,
            ...(unit ? {native_unit: unit.unit} : {}),
            ...(amount !== undefined ? {amount, ...(account.currency ? {currency: account.currency} : {})} : {}),
          });
        } else walk(x, path + '/' + k, depth + 1);
      }
  };
  walk(plan.body, '', 0);
  const accountText = account.name ? account.name + ' (' + plan.accountId + ')' : String(plan.accountId ?? '');
  const parts = [
    operation[0]!.toUpperCase() +
      operation.slice(1) +
      ' ' +
      count +
      ' ' +
      // Several of a thing: the plural its declaration gives, else the word and an s (a raw collection name already has one).
      (count === 1 ? entity : (plural ?? (/s$/.test(entity) ? entity : entity + 's'))) +
      (accountText ? ' in account ' + accountText : ''),
    ...amounts
      .slice(0, 5)
      .map(
        a =>
          a.field.split('/').at(-1) +
          ' ' +
          (a.amount !== undefined ? a.amount + (a.currency ? ' ' + a.currency : ' in account currency') + ' (' : '') +
          a.native +
          (a.native_unit ? ' ' + a.native_unit : '') +
          (a.amount !== undefined ? ')' : ''),
      ),
    ...statuses.slice(0, 5).map(s => s.field.split('/').at(-1) + ' ' + (s.from ? s.from + ' → ' : '') + s.to),
  ];
  return {
    text: parts.join('; ') + (amounts.length > 5 || statuses.length > 5 ? '; …' : '') + '.',
    operation,
    entity,
    count,
    account: {id: plan.accountId ?? null, ...account},
    // A summary stays small beside the request it summarizes: the first entries, and how many there are in all.
    ...(amounts.length ? {money: amounts.slice(0, summaryEntries)} : {}),
    ...(amounts.length > summaryEntries ? {money_total: amounts.length} : {}),
    ...(statuses.length ? {status: statuses.slice(0, summaryEntries)} : {}),
    ...(statuses.length > summaryEntries ? {status_total: statuses.length} : {}),
    authority: 'The exact native request below is what is sent; this line only summarizes it.',
  };
}
