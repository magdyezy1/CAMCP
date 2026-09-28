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
    evidence: 'CampaignBudget.amountMicros, pinned Google Ads v23 Discovery document',
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

/** The native amount for a cap stated in account currency, or undefined where the platform's unit is not documented. */
export function nativeAmount(gateway: string, currencyAmount: number): number | undefined {
  const unit = budgetUnits[gateway];
  return unit ? Math.round(currencyAmount * unit.perCurrencyUnit * 1e6) / 1e6 : undefined;
}
