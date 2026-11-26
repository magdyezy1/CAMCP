import type {CompiledRequest, JsonObject} from './types.js';
import {budgetUnits, exactAmount, readableAmount} from './budget-units.js';
import {changeRank, showRow} from './plan-approval.js';
import {
  clip,
  isAmount,
  nameLimit,
  requestChanges,
  targetKeys,
  type ChangeValue,
  type RequestChange,
} from './request-changes.js';
import {accountRecord, declaredOperation, listedIds, targetRecord} from './write-effects.js';
import {scrubPeople} from './personal-data.js';
import {providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';
import {redactCredentialShapesWithPaths} from './security.js';

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
 * an "ad campaign"), or, for a route that is the id alone (Meta's `/v26.0/456`), the words of its action's name (Meta's ad set update says "ad set").
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
const flat = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const idTail = (id: string) => (id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id);
/**
 * The records of what a review read, by the id each names itself with (`id`, a resource name, or the `<entity>_id` of TikTok's reads): where the
 * names and the current values of what the request changes are (R2.5 r25-approval-fields, B6).
 */
function stateIndex(state: unknown[], entity: string): Map<string, JsonObject> {
  const keys = targetKeys(entity),
    index = new Map<string, JsonObject>(),
    scalar = (x: unknown): x is string | number => typeof x === 'string' || typeof x === 'number';
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(v)) return v.forEach(x => walk(x, depth + 1));
    if (!object(v)) return;
    const entries = Object.entries(v),
      own =
        entries.find(([k, x]) => ['id', 'resourcename'].includes(flat(k)) && scalar(x)) ??
        entries.find(([k, x]) => keys.has(flat(k)) && scalar(x));
    if (own && !index.has(idTail(String(own[1])))) index.set(idTail(String(own[1])), v);
    for (const [, x] of entries) walk(x, depth + 1);
  };
  walk(state, 0);
  return index;
}
/** The name a record read gives its object: its own `name` (or the entity's, or a display name), never a parent's. */
function nameIn(record: JsonObject | undefined, entity: string): string | undefined {
  if (!record) return undefined;
  for (const wanted of ['name', flat(entity) + 'name', 'displayname', 'descriptivename']) {
    const key = Object.keys(record).find(k => flat(k) === wanted && typeof record[k] === 'string' && record[k]);
    if (key) return clip(String(record[key]), nameLimit);
  }
  return undefined;
}
/** The value a field has in a record read, whichever way the platform spells it (amount_micros, amountMicros); a nested value is not one. */
function valueIn(record: JsonObject | undefined, field: string): ChangeValue | undefined {
  if (!record) return undefined;
  const wanted = snake(field.split('.')[0]!),
    key = Object.keys(record).find(k => snake(k) === wanted),
    v = key === undefined ? undefined : record[key];
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
}
const deletion = (r: RequestChange) => r.field === 'object' && r.new === 'deleted';
/** What one row says in a line: the field, its old value where the review read one, and the value it is given, money in the account's currency. */
function rowText(r: RequestChange, gateway: string, currency?: string): string {
  // The row of an object a request deletes beside what it changes of another (a Google update and a remove in one request).
  if (deletion(r)) return 'deleted';
  const leaf = r.field.split('.').at(-1) ?? r.field,
    money = changeRank(r.field) === 0 && typeof r.new !== 'object' && r.new !== null,
    now = money ? readableAmount(gateway, leaf, r.new, currency) : undefined,
    same = r.old !== undefined && String(r.old) === String(r.new);
  if (now) {
    const before = r.old === undefined || same ? undefined : readableAmount(gateway, leaf, r.old, currency);
    return (
      r.field +
      ' ' +
      (before ? before.amount + ' → ' : '') +
      now.amount +
      ' ' +
      (now.currency ?? 'in account currency') +
      ' (' +
      r.new +
      ' ' +
      now.unit +
      ')' +
      (same ? ' (unchanged)' : '')
    );
  }
  // An amount the platform counts in a documented unit that the line cannot convert (a field not named for its unit: Reddit's goal_value, in
  // microcurrency) keeps that unit, as the line always said it.
  const unit = money && isAmount(r.new) ? budgetUnits[gateway]?.unit : undefined;
  return (
    r.field +
    ' ' +
    (r.old !== undefined && !same ? r.old + ' → ' : '') +
    r.new +
    (unit ? ' ' + unit : '') +
    (same ? ' (unchanged)' : '')
  );
}
/** Objects the line names, and changes it lists of each: the rest are counted. */
const objectsNamed = 3,
  changesNamed = 4;
export function reviewSummary(
  plan: CompiledRequest,
  state: unknown[],
  stored?: {name?: string; currency?: string},
): JsonObject {
  const {operation, entity, count, plural} = operationOf(plan),
    // What the review read of the account first; what the account's last live read stored where the review's reads name none (a Google budget's
    // review reads no customer, so "in account currency" was said of an account known to be in USD).
    account = {...stored, ...accountOf(state)},
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
          // Converted where the platform's unit is documented and the field is an amount of it (src/budget-units.ts `readableAmount`: micros, the
          // account currency, and Meta's minor unit by the account currency's offset); otherwise native, as it was.
          const converted = readableAmount(plan.gateway, k, x, account.currency);
          amounts.push({
            field: path + '/' + k,
            native: x,
            ...(unit || converted ? {native_unit: (unit ?? converted)!.unit} : {}),
            ...(converted
              ? {amount: converted.amount, ...(converted.currency ? {currency: converted.currency} : {})}
              : {}),
          });
        } else walk(x, path + '/' + k, depth + 1);
      }
  };
  walk(plan.body, '', 0);
  // What the request changes, row by row: the object and its id, the field and the value it is given, and where the review read them, the name of
  // the object and the value it has now (the same rows the plan approval shows, from the review's own before-state).
  let index = new Map<string, JsonObject>(),
    rows: RequestChange[] = [];
  try {
    // The names and values come from the state as the review shows it: the scrubbed one (a name that holds a credential shape or a person is
    // not in the line either).
    index = stateIndex(scrubPeople(redactCredentialShapesWithPaths(state).value) as unknown[], entity);
    rows = requestChanges(plan, {
      operation,
      entity,
      plural,
      names: id => nameIn(index.get(id), entity),
      before: (id, field) => valueIn(index.get(id), field),
    });
  } catch {
    // A request whose entity the summary cannot name has no rows, and the line says what it always said: the head, the money and the statuses.
  }
  const byObject = new Map<string, RequestChange[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.object, r.id ?? r.ids ?? null]);
    byObject.set(key, [...(byObject.get(key) ?? []), r]);
  }
  // The line says of an edit every field it sets, and of a create its money, status and dates (and the people it uploads, withheld): the name is in
  // the object's label, and the rest of what a create sets (targeting, goals, placements) is in the rows below, counted.
  const created = operation === 'create',
    // A deletion is said of the object where the request changes something else too; a request that only deletes is its head and the ids it names.
    eligible = (r: RequestChange) =>
      deletion(r)
        ? rows.some(x => !deletion(x))
        : !created ||
          changeRank(r.field) === 1 ||
          changeRank(r.field) === 2 ||
          r.field === 'people' ||
          (changeRank(r.field) === 0 && isAmount(r.new));
  // Each object's changes in a line, each said once (a request that makes ten of one thing says its status once), the first few of them.
  const everyone = [...byObject.values()].map(list => ({
      first: list[0]!,
      texts: [...new Set(list.filter(eligible).map(r => rowText(r, plan.gateway, account.currency)))],
    })),
    // An object the line can say nothing of, with neither a name nor an id (the rest of a request that lists its records beside a parent's ID), is
    // left out: it would only repeat the head.
    said = everyone.filter(
      ({first, texts}) =>
        texts.length > 0 || first.id !== undefined || first.ids !== undefined || /"/.test(first.object),
    ),
    clauses = said.slice(0, objectsNamed).map(({first, texts}) => {
      const who = first.ids
        ? first.ids.slice(0, 3).join(', ') + (first.ids.length > 3 ? ' and ' + (first.ids.length - 3) + ' more' : '')
        : first.id;
      return (
        first.object +
        (who ? ' (' + who + ')' : '') +
        (texts.length ? ': ' + texts.slice(0, changesNamed).join(', ') : '')
      );
    }),
    hidden = said.reduce(
      (n, {texts}, i) => n + (i < objectsNamed ? Math.max(0, texts.length - changesNamed) : texts.length),
      0,
    );
  const accountText = account.name ? account.name + ' (' + plan.accountId + ')' : String(plan.accountId ?? '');
  const head =
    operation[0]!.toUpperCase() +
    operation.slice(1) +
    ' ' +
    count +
    ' ' +
    // Several of a thing: the plural its declaration gives, else the word and an s (a raw collection name already has one).
    (count === 1 ? entity : (plural ?? (/s$/.test(entity) ? entity : entity + 's'))) +
    (accountText ? ' in account ' + accountText : '');
  const objects = [
    ...new Map(
      rows
        .flatMap(r => r.ids ?? (r.id === undefined ? [] : [r.id]))
        .map(id => [id, nameIn(index.get(id), entity)] as const)
        .filter(([, name]) => name !== undefined),
    ),
  ]
    .slice(0, summaryEntries)
    .map(([id, name]) => ({id, name}));
  // With no row to read (a request whose entity the summary could not name), the line is what it was: the head, the money and the statuses.
  const legacy = rows.length
    ? []
    : [
        ...amounts
          .slice(0, 5)
          .map(
            a =>
              a.field.split('/').at(-1) +
              ' ' +
              (a.amount !== undefined
                ? a.amount + (a.currency ? ' ' + a.currency : ' in account currency') + ' ('
                : '') +
              a.native +
              (a.native_unit ? ' ' + a.native_unit : '') +
              (a.amount !== undefined ? ')' : ''),
          ),
        ...statuses.slice(0, 5).map(s => s.field.split('/').at(-1) + ' ' + (s.from ? s.from + ' → ' : '') + s.to),
      ];
  return {
    text:
      head +
      (clauses.length ? ': ' + clauses.join('; ') : legacy.length ? '; ' + legacy.join('; ') : '') +
      (hidden > 0 ? '; and ' + hidden + ' more' : '') +
      (!rows.length && (amounts.length > 5 || statuses.length > 5) ? '; …' : '') +
      '.',
    operation,
    entity,
    count,
    account: {id: plan.accountId ?? null, ...account},
    // A summary stays small beside the request it summarizes: the first entries, and how many there are in all.
    ...(amounts.length ? {money: amounts.slice(0, summaryEntries)} : {}),
    ...(amounts.length > summaryEntries ? {money_total: amounts.length} : {}),
    ...(statuses.length ? {status: statuses.slice(0, summaryEntries)} : {}),
    ...(statuses.length > summaryEntries ? {status_total: statuses.length} : {}),
    // The rows of what it changes, the first of them (the request below holds every one), and the objects whose names the review read.
    ...(rows.length
      ? {changes: rows.slice(0, summaryEntries).map(r => showRow({...r}, plan.gateway, account.currency))}
      : {}),
    ...(rows.length > summaryEntries ? {changes_total: rows.length} : {}),
    ...(objects.length ? {objects} : {}),
    authority: 'The exact native request below is what is sent; this line only summarizes it.',
  };
}
