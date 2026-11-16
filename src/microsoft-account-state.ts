/**
 * The Microsoft Advertising account row that a review keeps to its identity (R2.5 M1, plan idea 1: the ACCOUNT role; lead
 * review S3-3).
 *
 * Every reviewed Microsoft write reads the account first (`GetAccount`, src/microsoft-native.ts), to prove the account is
 * the one the connection selected and to carry its currency. The answer is the whole `AdvertiserAccount` of the Customer
 * Management API (`.mirror/VENDOR/microsoft-customer-management-v13.json`), and three of its fields change without any edit:
 * `TimeStamp`, its row version, and `LastModifiedByUserId`, which change together with `LastModifiedTime` (the table of
 * src/microsoft-adapter.ts drops that one) on any change of the account record, and `AccountFinancialStatus`, which billing
 * sets. The account has no balance. A review keeps who the account is and what it is under, the fields
 * src/microsoft-login.ts reads of it to select it, and why it is paused: its ID and number, its name, the customer it
 * belongs to, its currency and time zone, its life-cycle status and the reason it was paused. A change of any of them still
 * refuses.
 *
 * Idempotent and monotone (src/review-state-core.ts pickIdentity: it only drops fields), so a state saved before is
 * projected again at execute.
 */
import {pickIdentity} from './review-state-core.js';

const accountFields: readonly string[] = Object.freeze([
  'Id',
  'Number',
  'Name',
  'ParentCustomerId',
  'CurrencyCode',
  'TimeZone',
  'AccountLifeCycleStatus',
  'PauseReason',
]);

export const microsoftAccountState = (row: unknown): unknown => pickIdentity(row, accountFields);
