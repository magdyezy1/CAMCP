import {pickIdentity} from './review-state-core.js';

/**
 * What a review keeps of the ad account a LinkedIn write is made under (R2.5 M1, L5-01): who it is, its status, its
 * currency, its type and the organization it belongs to (`reference`), and whether it is a test account. Its serving state,
 * version tag, audit stamps and notification settings change with edits that no write under it depends on. LinkedIn offers
 * no way to ask for fewer fields, so the projection is the narrowing. Idempotent and monotone (it only drops fields).
 *
 * A leaf, so the adapter (for the account read of a create) and the families that read the account themselves (conversion
 * rules and links, audience templates) keep the same record.
 */
export const linkedinAccountFields: readonly string[] = Object.freeze([
  'id',
  'name',
  'status',
  'currency',
  'type',
  'reference',
  'test',
]);
export const linkedinAccountState = (row: unknown): unknown => pickIdentity(row, linkedinAccountFields);
