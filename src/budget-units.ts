import {createHash} from 'node:crypto';
import {pinnedJson} from './pinned-json.js';
import {providerOf} from './provider-adapters.js';

/**
 * How a platform's API counts budget and bid amounts, so an owner can state a cap in account currency and the spending
 * policy compares the native amount (review 2026-09-28, F-04). A platform is listed only where the unit is documented
 * in a pinned vendor document or named by the API's own fields. Meta counts the account currency's minor unit, which
 * differs by currency, so it converts per currency through metaCurrencyOffset (WRT-07); TikTok and Criteo are not
 * documented, so their caps stay in native units.
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
 * Whether a gateway's amounts are the account currency times a per-currency offset (Meta's minor units): its adapter's
 * fact (ARC-01 phase B, src/provider-adapters.ts `currencyOffsetBudgets`).
 */
const countsCurrencyOffset = (gateway: string) => providerOf(gateway)?.currencyOffsetBudgets === true;

/**
 * The native amount for a cap stated in account currency, or undefined where the platform's unit is not documented.
 * Meta counts money in the account currency's minor unit (its "offset"), so a Meta cap converts only with the account
 * currency and a pinned offset table (WRT-07 Stage C, metaCurrencyOffset).
 */
export function nativeAmount(gateway: string, currencyAmount: number, currency?: string | null): number | undefined {
  const perUnit =
    budgetUnits[gateway]?.perCurrencyUnit ??
    (countsCurrencyOffset(gateway) && currency ? metaCurrencyOffset(currency) : undefined);
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
 * Meta's per-currency offsets (WRT-07 Stage C): native budget, bid and spend-cap amounts are the account currency times
 * its offset (100 for USD cents, 1 for JPY). They come only from the pinned capture of Meta's Marketing API Currencies
 * page, .mirror/VENDOR/meta-currencies.json ({source_url, captured_at, sha256, currencies: [{code, name, offset}]},
 * captured 2026-10-11), never from ISO 4217: Meta counts COP, HUF, IDR and TWD in whole units and BHD and JOD in
 * hundredths. A currency the capture does not list (KWD, OMR) has no offset, and a Meta cap for it must be stated
 * natively: a guessed offset would loosen or block a cap a hundredfold. A capture that fails its checks is not used.
 */
export interface MetaCurrencyCapture {
  source_url: string;
  captured_at: string;
  offsets: Readonly<Record<string, number>>;
}
const metaOffsetValues = [1, 10, 100, 1000];
let metaCapture: MetaCurrencyCapture | null | undefined;
/**
 * The offsets of a Meta currency capture, or null when any check fails: a Meta developer-documentation source, a
 * capture date, a SHA-256 that matches JSON.stringify(currencies), and rows each with a distinct ISO-shaped code and an
 * offset of 1, 10, 100 or 1000. One bad row rejects the whole capture rather than leaving a partial table.
 */
export function parseMetaCurrencyCapture(data: unknown): MetaCurrencyCapture | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>,
    rows = d.currencies;
  if (
    typeof d.source_url !== 'string' ||
    !/^https:\/\/developers\.facebook\.com\//.test(d.source_url) ||
    typeof d.captured_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.captured_at) ||
    !Array.isArray(rows) ||
    !rows.length ||
    d.sha256 !== createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  )
    return null;
  const offsets: Record<string, number> = {};
  for (const row of rows as unknown[]) {
    const r = row as Record<string, unknown> | null;
    if (
      !r ||
      typeof r.code !== 'string' ||
      !/^[A-Z]{3}$/.test(r.code) ||
      Object.hasOwn(offsets, r.code) ||
      typeof r.offset !== 'number' ||
      !metaOffsetValues.includes(r.offset)
    )
      return null;
    offsets[r.code] = r.offset;
  }
  return Object.freeze({source_url: d.source_url, captured_at: d.captured_at, offsets: Object.freeze(offsets)});
}
function loadedMetaCapture(): MetaCurrencyCapture | null {
  if (metaCapture === undefined) {
    try {
      metaCapture = parseMetaCurrencyCapture(pinnedJson('.mirror/VENDOR/meta-currencies.json'));
    } catch {
      // Missing or unreadable in this image: Meta caps stay native, and owner health says the capture is not pinned.
      metaCapture = null;
    }
  }
  return metaCapture;
}
export function metaCurrencyOffset(currency: string): number | undefined {
  const offsets = loadedMetaCapture()?.offsets,
    offset = offsets && Object.hasOwn(offsets, currency) ? offsets[currency] : undefined;
  return typeof offset === 'number' && metaOffsetValues.includes(offset) ? offset : undefined;
}
/** Whether a valid pinned Meta currency capture is loaded (owner health names its absence). */
export function metaCurrencyOffsetsPinned(): boolean {
  return !!loadedMetaCapture();
}
/** The loaded Meta capture's source and date, for owner health and saved policies; undefined without one. */
export function metaCurrencySource(): {source_url: string; captured_at: string; currencies: number} | undefined {
  const c = loadedMetaCapture();
  return c
    ? {source_url: c.source_url, captured_at: c.captured_at, currencies: Object.keys(c.offsets).length}
    : undefined;
}
/** Tests install a synthetic capture; `undefined` reloads the pinned file. */
export function setMetaCurrencyOffsetsForTest(offsets: Record<string, number> | null | undefined): void {
  metaCapture =
    offsets === undefined
      ? undefined
      : offsets
        ? Object.freeze({
            source_url: 'synthetic test capture',
            captured_at: 'test',
            offsets: Object.freeze({...offsets}),
          })
        : null;
}
/**
 * The unit a saved account policy names for its native caps (`native_unit`): the platform's documented unit, or for
 * Meta the offset of the caps' currency with the capture it came from, so a later capture never reinterprets it.
 */
export function policyNativeUnit(gateway: string, currency: unknown): BudgetUnit | undefined {
  const unit = budgetUnits[gateway];
  if (unit || !countsCurrencyOffset(gateway) || typeof currency !== 'string') return unit;
  const offset = metaCurrencyOffset(currency),
    source = metaCurrencySource();
  return offset && source
    ? {
        perCurrencyUnit: offset,
        unit: offset === 1 ? 'whole ' + currency : '1/' + offset + ' ' + currency,
        evidence:
          'Meta currency offset ' +
          offset +
          ' for ' +
          currency +
          ', ' +
          source.source_url +
          ' (' +
          source.captured_at +
          ')',
      }
    : undefined;
}
/**
 * Meta's entry in owner health's budget units when the capture is loaded: the settings page then offers Meta caps in
 * account currency, which the server converts with the currency of the caps. Like the other entries, unit and evidence
 * are literal source facts; the website words the guidance around them (web/owner-operations.js policyUnitNote).
 */
export function metaBudgetUnit(): {unit: string; evidence: string} | undefined {
  const source = metaCurrencySource();
  return source
    ? {
        unit: 'account currency minor units (Meta currency offset)',
        evidence:
          'Meta Marketing API Currencies page, offsets of ' +
          source.currencies +
          ' currencies captured ' +
          source.captured_at +
          ': 100 USD is 10000, 100 JPY is 100',
      }
    : undefined;
}
