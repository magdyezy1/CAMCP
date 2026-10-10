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

/** The native amount for a cap stated in account currency, or undefined where the platform's unit is not documented. */
export function nativeAmount(gateway: string, currencyAmount: number): number | undefined {
  const unit = budgetUnits[gateway];
  return unit ? Math.round(currencyAmount * unit.perCurrencyUnit * 1e6) / 1e6 : undefined;
}
