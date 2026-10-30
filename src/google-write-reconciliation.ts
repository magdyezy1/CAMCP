import type {CompiledRequest, JsonObject} from './types.js';
import type {CreatedLookup, StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {googleAdsCustomers} from './google-version.js';
import {normalize} from './verification-core.js';
import {object} from './write-common.js';

// Writes and campaigns (ARC-01 phase B, wave 4c): Google Ads' parts of the read-only reconciliation of an uncertain
// write, moved verbatim from src/write-reconciliation.ts, which asks them as the adapter's `writes.createdLookup` and
// `writes.namedTargets`; its state reads are built with the stage's read builder.
const gaqlText = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 255 && !/['\\\n\r]/.test(v);
const googleCreatable: Record<string, string> = {
  campaigns: 'campaign',
  campaignBudgets: 'campaign_budget',
  adGroups: 'ad_group',
  assetGroups: 'asset_group',
};
/**
 * Google Ads creates of named resources (campaigns, budgets, ad groups, asset groups): one bounded search by the frozen
 * names. Google refuses a duplicate name for these, so one match per name is the created resource.
 */
export function googleCreated(plan: CompiledRequest, read: StateReadBuilder): CreatedLookup | undefined {
  const kind = /\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1],
    resource = kind ? googleCreatable[kind] : undefined,
    operations = object(plan.body).operations;
  if (!resource || !Array.isArray(operations) || !operations.length || operations.some(op => !object(op).create))
    return undefined;
  const names = operations.map(op => object(op).create.name);
  if (!names.every(gaqlText) || new Set(names).size !== names.length) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!);
  const query =
    'SELECT ' +
    resource +
    '.resource_name, ' +
    resource +
    '.name FROM ' +
    resource +
    ' WHERE ' +
    resource +
    '.name IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    ') LIMIT 100';
  return {
    reads: [read(googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST')],
    match(responses) {
      const rows = (normalize(object(responses[0]?.data).results ?? []) as JsonObject[]).map(r => object(r[resource]));
      const found = names.map(name => rows.filter(r => r.name === name));
      return {
        expected: names.length,
        complete: !object(responses[0]?.data).nextPageToken,
        found: found.every(list => list.length === 1)
          ? found.map((list, index) => ({index, id: list[0]!.resource_name, name: names[index]}))
          : found.flat().map(r => ({id: r.resource_name, name: r.name})),
      };
    },
    receipt: found => ({results: found.map(f => ({resourceName: f.id}))}),
  };
}
/** An update or removal of Google Ads operations: the receipt names each operation's resource. */
export function googleNamedTargets(plan: CompiledRequest): JsonObject | undefined {
  const body = object(plan.body);
  if (Array.isArray(body.operations) && body.operations.length) {
    const names = body.operations.map((op: JsonObject) => {
      const update = object(op.update);
      return op.create ? undefined : (op.remove ?? update.resourceName ?? update.resource_name);
    });
    return names.every((n: unknown) => typeof n === 'string')
      ? {success: true, data: {results: names.map((resourceName: string) => ({resourceName}))}}
      : undefined;
  }
  return undefined;
}
