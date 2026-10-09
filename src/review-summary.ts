import type {CompiledRequest, JsonObject} from './types.js';
import {budgetUnits} from './budget-units.js';
import {stateTarget} from './write-effects.js';

/**
 * A one-line, server-authored summary of a reviewed write (WRT-05 Stage E), shown above the exact native table, which
 * stays the authority: what the request does (operation, how many of which entity), on which account (its name and
 * currency when the review read them), the money it sets converted through the budget-unit contract with exact
 * decimals, and the status changes it makes. Values are never rounded and never guessed: an amount is converted only
 * where the platform's unit is documented and the field names its unit; otherwise it stays native.
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const money = /budget|bid|amount|spend_cap|cpc|cpm|target_cpa/i;
const statusKeys = new Set(['status', 'entity_status', 'entityStatus', 'configured_status', 'operation_status']);
const googleKinds: Record<string, string> = {
  campaigns: 'campaign',
  adGroups: 'ad group',
  adGroupAds: 'ad group ad',
  campaignBudgets: 'campaign budget',
  ads: 'ad',
  assets: 'asset',
  assetGroups: 'asset group',
  campaignCriteria: 'campaign criterion',
  adGroupCriteria: 'ad group criterion',
  sharedSets: 'shared set',
  sharedCriteria: 'shared criterion',
  campaignSharedSets: 'campaign shared set',
};
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
/** native ÷ perUnit as an exact decimal with at least two places, or undefined for a value that is not a decimal. */
export function exactAmount(native: unknown, perUnit: number): string | undefined {
  const text = typeof native === 'number' ? (Number.isSafeInteger(native) ? String(native) : '') : String(native ?? '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m || !Number.isSafeInteger(perUnit) || perUnit < 1 || !/^10*$/.test(String(perUnit))) return undefined;
  const shift = String(perUnit).length - 1,
    fraction = m[3] ?? '',
    digits = ((m[2] ?? '0') + fraction).replace(/^0+(?=\d)/, ''),
    scale = fraction.length + shift,
    padded = digits.padStart(scale + 1, '0'),
    whole = padded.slice(0, padded.length - scale) || '0';
  let decimals = padded.slice(padded.length - scale).replace(/0+$/, '');
  if (decimals.length < 2) decimals = decimals.padEnd(2, '0');
  return (m[1] ?? '') + whole.replace(/^0+(?=\d)/, '') + '.' + decimals;
}
/** The account record a review read (a currency marks it), as id, name and currency. */
function accountOf(state: unknown[]): {name?: string; currency?: string} {
  const find = (v: unknown, depth: number): JsonObject | undefined => {
    if (depth > 5) return undefined;
    if (Array.isArray(v)) {
      for (const x of v) {
        const found = find(x, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (!object(v)) return undefined;
    if (typeof v.currency === 'string' || typeof v.currencyCode === 'string' || typeof v.currency_code === 'string')
      return v;
    for (const x of Object.values(v)) {
      const found = find(x, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  const record = find(state, 0);
  if (!record) return {};
  const name = record.descriptiveName ?? record.descriptive_name ?? record.name,
    currency = record.currency ?? record.currencyCode ?? record.currency_code;
  return {
    ...(typeof name === 'string' && name.length <= 200 ? {name} : {}),
    ...(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? {currency} : {}),
  };
}
/** What the request does: an operation and the entities it acts on. */
function operationOf(plan: CompiledRequest): {operation: string; entity: string; count: number} {
  const body = plan.body as unknown;
  if (plan.gateway === 'google_ads_native_action') {
    const kind = /\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1] ?? '',
      operations = object(body) && Array.isArray(body.operations) ? body.operations : [];
    const ops = operations.map((op: JsonObject) =>
      op?.create !== undefined ? 'create' : op?.remove !== undefined ? 'remove' : 'update',
    );
    const kinds = [...new Set(ops)];
    return {
      operation: kinds.length === 1 ? (kinds[0] as string) : 'change',
      entity: googleKinds[kind] ?? kind,
      count: ops.length || 1,
    };
  }
  const segments = plan.path.split('/').filter(Boolean),
    collection = [...segments].reverse().find(s => Object.hasOwn(singular, s.replace(/:.*/, ''))) ?? '',
    key = collection.replace(/:.*/, ''),
    rows = object(body) && Array.isArray(body[key]) ? body[key].length : Array.isArray(body) ? 1 : 1;
  const action = plan.action.toLowerCase();
  const operation =
    plan.method === 'DELETE' || /(?:^|_)delete(?:_|$)/.test(action) || plan.destructive
      ? 'delete'
      : /:publish$/.test(plan.path)
        ? 'publish'
        : /(?:^|_)(?:create|post)(?:_|$)/.test(action) && segments.at(-1) === key
          ? 'create'
          : 'update';
  return {operation, entity: singular[key] ?? (key || segments.at(-1) || 'resource'), count: rows};
}
export function reviewSummary(plan: CompiledRequest, state: unknown[]): JsonObject {
  const {operation, entity, count} = operationOf(plan),
    account = accountOf(state),
    unit = budgetUnits[plan.gateway],
    target = operation === 'create' ? undefined : stateTarget(state);
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
          const amount = converts ? exactAmount(x, unit!.perCurrencyUnit) : undefined;
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
      entity +
      (count === 1 ? '' : 's') +
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
    ...(amounts.length ? {money: amounts} : {}),
    ...(statuses.length ? {status: statuses} : {}),
    authority: 'The exact native request below is what is sent; this line only summarizes it.',
  };
}
