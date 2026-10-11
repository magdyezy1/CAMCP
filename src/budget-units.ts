import {optionalPinnedJson} from './pinned-json.js';

/**
 * How a platform's API counts budget and bid amounts, so an owner can state a cap in account currency and the spending
 * policy compares the native amount (review 2026-09-28, F-04). A platform is listed only where the unit is documented
 * in a pinned vendor document or named by the API's own fields; Meta (minor units by currency offset), TikTok and
 * Criteo are not, so their caps stay in native units.
 */
export interface BudgetUnit {
  /** Native units per one unit of the account currency. */
  perCurrencyUnit: number;
  unit: string;
  evidence: string;
}

export const budgetUnits: Readonly<Record<string, BudgetUnit>> = Object.freeze({
  google_ads_native_action: {
    perCurrencyUnit: 1_000_000,
    unit: 'micros',
    evidence: 'CampaignBudget.amountMicros, pinned Google Ads v25 Discovery document',
  },
  dv360_native_action: {
    perCurrencyUnit: 1_000_000,
    unit: 'micros',
    evidence: 'budgetAmountMicros and bidAmountMicros, pinned DV360 v4 Discovery document',
  },
  reddit_native_action: {
    perCurrencyUnit: 1_000_000,
    unit: 'microcurrency',
    evidence: 'goal_value and bid_value "(microcurrency)", pinned Reddit v3 OpenAPI document',
  },
  snapchat_native_action: {
    perCurrencyUnit: 1_000_000,
    unit: 'micros',
    evidence: 'daily_budget_micro, lifetime_spend_cap_micro and bid_micro fields of the captured catalog',
  },
  x_ads_native_action: {
    perCurrencyUnit: 1_000_000,
    unit: 'local micros',
    evidence: 'daily_budget_amount_local_micro and bid_amount_local_micro fields of the captured catalog',
  },
  microsoft_ads_native_action: {
    perCurrencyUnit: 1,
    unit: 'account currency',
    evidence: 'DailyBudget xs:double, pinned Campaign Management v13 WSDL',
  },
  linkedin_native_action: {
    perCurrencyUnit: 1,
    unit: 'account currency',
    evidence: 'dailyBudget and unitCost {amount, currencyCode} of the captured catalog',
  },
  apple_ads_native_action: {
    perCurrencyUnit: 1,
    unit: 'account currency',
    evidence: 'dailyBudgetAmount and bidAmount {amount, currency} of the AMCP Apple Ads contract',
  },
});

/**
 * Lifetime and custom-period total amounts (owner decision D7 of 2026-10-08, WRT-01 stage C). The owner's optional
 * max_total_budget_native caps them (max_budget_native when it is not set), and a decrease from the one current value
 * is always allowed, even above a cap. Each platform lists the fields with the evidence for them and their unit, which
 * is the platform's native budget unit; a field not listed is compared like a daily budget.
 */
export interface LifetimeAmounts {
  /** Request field names, or the name of the money object whose `amount` is the total (LinkedIn totalBudget). */
  fields: readonly string[];
  unit: string;
  evidence: string;
}

export const lifetimeAmounts: Readonly<Record<string, LifetimeAmounts>> = Object.freeze({
  google_ads_native_action: {
    fields: ['total_amount_micros'],
    unit: 'micros',
    evidence:
      'CampaignBudget.totalAmountMicros "The total amount to be spent by the campaign over its entire duration", pinned Google Ads v25 Discovery document',
  },
  reddit_native_action: {
    fields: ['spend_cap'],
    unit: 'microcurrency',
    evidence: 'campaign spend_cap "Campaign lifetime spend cap (microcurrency)", pinned Reddit v3 OpenAPI document',
  },
  meta_native_action: {
    fields: ['spend_cap', 'lifetime_budget'],
    unit: 'the account currency minor unit of daily_budget',
    evidence:
      'campaign spend_cap and lifetime_budget, stated like daily_budget in the currency minor unit (Marketing API Campaign reference)',
  },
  snapchat_native_action: {
    fields: ['lifetime_spend_cap_micro', 'lifetime_budget_micro'],
    unit: 'micros',
    evidence:
      'lifetime_spend_cap_micro of the captured catalog; ad squad lifetime_budget_micro "Lifetime budget (micro-currency)"',
  },
  x_ads_native_action: {
    fields: ['total_budget_amount_local_micro'],
    unit: 'local micros',
    evidence: 'total_budget_amount_local_micro field of the captured catalog',
  },
  linkedin_native_action: {
    fields: ['total_budget'],
    unit: 'account currency',
    evidence: 'totalBudget {amount, currencyCode} of the captured catalog',
  },
});

/** True when the amount at `path` named `key` is a lifetime or total amount of `gateway` (D7). */
export function lifetimeAmount(gateway: string, path: string, key: string): boolean {
  const fields = lifetimeAmounts[gateway]?.fields;
  if (!fields) return false;
  return fields.includes(key) || (key === 'amount' && fields.includes(path.split('/').at(-2) ?? ''));
}

/**
 * The native amount for a cap stated in account currency, or undefined where the platform's unit is not documented.
 * Meta counts money in the account currency's minor unit (its "offset"), so a Meta cap converts only with the account
 * currency and a pinned offset table (WRT-07 Stage C, metaCurrencyOffset).
 */
export function nativeAmount(gateway: string, currencyAmount: number, currency?: string | null): number | undefined {
  const perUnit =
    budgetUnits[gateway]?.perCurrencyUnit ??
    (gateway === 'meta_native_action' && currency ? metaCurrencyOffset(currency) : undefined);
  return perUnit ? Math.round(currencyAmount * perUnit * 1e6) / 1e6 : undefined;
}

/**
 * ISO 4217 minor units (WRT-07 Stage A), pinned here rather than read from the runtime's ICU data, which changes with
 * Node releases: currencies with no minor unit, and those with three or four. Every other well-formed code has two.
 * Source: ISO 4217 list one (current currency and funds code list), minor-unit column.
 */
const isoMinorDigits: Readonly<Record<string, number>> = Object.freeze({
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
});
/** The digits after the decimal point of an ISO 4217 currency (JPY 0, USD 2, KWD 3), or undefined for a malformed code. */
export function currencyMinorDigits(currency: unknown): number | undefined {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return isoMinorDigits[currency] ?? 2;
}
/**
 * The smallest amount of `currency` a platform that counts micros (or account currency) can be charged, in micros of
 * the currency: 10000 for USD, 1000000 for JPY and CLP, 1000 for KWD. Google refuses a budget that is not a multiple of
 * it (NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT). Undefined for a malformed currency code.
 */
export function minimumUnitMicros(currency: unknown): bigint | undefined {
  const digits = currencyMinorDigits(currency);
  return digits === undefined ? undefined : 10n ** BigInt(Math.max(0, 6 - digits));
}
/** An exact micros amount in currency units with the currency's own digits: 500000000 JPY micros is "500". */
export function currencyText(micros: bigint, currency: string): string {
  const digits = currencyMinorDigits(currency) ?? 2,
    negative = micros < 0n,
    value = negative ? -micros : micros,
    whole = value / 1000000n,
    fraction = (value % 1000000n).toString().padStart(6, '0'),
    shown = fraction.slice(0, Math.max(digits, fraction.replace(/0+$/, '').length));
  return (negative ? '-' : '') + whole.toString() + (shown ? '.' + shown : '');
}

/**
 * Meta's per-currency offsets (WRT-07 Stage C): native budget amounts are the account currency times its offset (100 for
 * USD cents, 1 for JPY). Only a pinned capture of Meta's currency table may supply them, with its source URL, SHA-256 and
 * capture date, in .mirror/VENDOR/meta-currencies.json ({source_url, sha256, captured_at, offsets: {USD: 100, ...}}).
 * Without that capture, or for a currency it does not list, a Meta cap must be stated natively: a wrong offset would
 * loosen or block a cap a hundredfold.
 */
let metaOffsets: Readonly<Record<string, number>> | null | undefined;
export function metaCurrencyOffset(currency: string): number | undefined {
  if (metaOffsets === undefined) metaOffsets = loadMetaOffsets();
  const offset = metaOffsets?.[currency];
  return typeof offset === 'number' && [1, 10, 100, 1000].includes(offset) ? offset : undefined;
}
/** Whether a pinned Meta currency capture is present (owner health names its absence). */
export function metaCurrencyOffsetsPinned(): boolean {
  if (metaOffsets === undefined) metaOffsets = loadMetaOffsets();
  return !!metaOffsets;
}
/** Tests install a synthetic capture; `undefined` reloads the pinned file. */
export function setMetaCurrencyOffsetsForTest(offsets: Record<string, number> | null | undefined): void {
  metaOffsets = offsets === undefined ? undefined : offsets ? Object.freeze({...offsets}) : null;
}
function loadMetaOffsets(): Readonly<Record<string, number>> | null {
  try {
    // Absent until the owner captures Meta's currency table: Meta caps then stay in native units.
    const data = optionalPinnedJson('.mirror/VENDOR/meta-currencies.json');
    if (
      typeof data?.source_url !== 'string' ||
      !/^[0-9a-f]{64}$/.test(String(data.sha256)) ||
      typeof data.captured_at !== 'string' ||
      !data.offsets ||
      typeof data.offsets !== 'object'
    )
      return null;
    return Object.freeze(
      Object.fromEntries(
        Object.entries(data.offsets as Record<string, unknown>).filter(
          ([code, offset]) => /^[A-Z]{3}$/.test(code) && typeof offset === 'number',
        ),
      ) as Record<string, number>,
    );
  } catch {
    return null;
  }
}
