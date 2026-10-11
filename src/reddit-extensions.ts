import type {VendorRoute} from './delegated-native.js';
import type {CompiledRequest, Connection, JsonObject, ToolDefinition} from './types.js';
import {pinnedJson} from './pinned-json.js';
import {MirrorError} from './errors.js';

// Independent AMCP extensions from Reddit's published v3 OpenAPI contract.
// Keep the captured AMCP registry and its denominators unchanged.
export const redditAudienceActions = ['CREATE_SAVED_AUDIENCE', 'UPDATE_SAVED_AUDIENCE'];
/**
 * PRV-07 C: planning and diagnosis reads from the pinned v3 OpenAPI (.mirror/VENDOR/reddit-v3.json). All are POST
 * reads under adsread. Delivery estimates and account history name the ad account in their path; bid and keyword
 * suggestions are account-agnostic planning reads that run under a bound account and take no account-owned references.
 * Account history names the people who made changes, so its response keeps only the change and its time.
 */
const redditReads = [
  [
    'GET_DELIVERY_ESTIMATES',
    'Audience and Delivery Estimates',
    '/ad_accounts/{ad_account_id}/forecasting/audience_and_delivery_estimates',
  ],
  ['GET_BID_SUGGESTIONS', 'Generate Bid Suggestion', '/forecasting/bid_suggestions'],
  ['GET_ACCOUNT_HISTORY', 'Get Ad Account History', '/ad_accounts/{ad_account_id}/history'],
  ['LIST_KEYWORD_SUGGESTIONS', 'List Keyword Suggestions', '/targeting/keyword_suggestions'],
] as const;
export const redditReadActions = redditReads.map(([action]) => action);
export function extendRedditTool(original: ToolDefinition): ToolDefinition {
  const tool = structuredClone(original),
    op = tool.operations?.find(o => o.operation === 'reddit_account_ops');
  if (op) {
    op.argumentsSchema.properties.action.enum.push(...redditAudienceActions, ...redditReadActions);
    op.argumentsSchema.properties.action.description =
      'Captured account actions plus independent AMCP saved-audience create/update and planning/history read extensions.';
  }
  return tool;
}
let readRoutes: VendorRoute[] | undefined;
/** The four read routes, built once from the pinned document's own request, response and parameter definitions. */
export function redditReadRoutes(): VendorRoute[] {
  if (readRoutes) return readRoutes;
  const pinned = pinnedJson('.mirror/VENDOR/reddit-v3.json'),
    document = pinned.document,
    resolve = (value: JsonObject) =>
      value?.$ref
        ? (value.$ref as string)
            .slice(2)
            .split('/')
            .reduce((o: JsonObject, key: string) => o[key.replaceAll('~1', '/').replaceAll('~0', '~')], document)
        : value;
  readRoutes = redditReads.map(([action, vendorMethod, path]) => {
    const item = document.paths[path],
      op = item?.post;
    if (op?.operationId !== vendorMethod) throw new Error('Pinned Reddit read route changed: ' + action);
    const server = new URL(document.servers[0].url);
    return {
      gateway: 'reddit_native_action',
      operation: 'reddit_account_ops',
      action,
      vendorMethod,
      source: pinned.source,
      sourceFile: 'reddit-v3',
      origin: server.origin,
      path: server.pathname + path,
      method: 'POST',
      readOnly: true,
      parameters: Object.fromEntries(
        [...(item.parameters ?? []), ...(op.parameters ?? [])]
          .map(resolve)
          .map((p: JsonObject) => [p.name, {...p, ...resolve(p.schema), location: p.in}]),
      ),
      requestSchema: resolve(op.requestBody).content['application/json'].schema,
      responseSchemas: {'200': resolve(op.responses['200']).content['application/json'].schema},
      bodyRequired: true,
      scopes: ['adsread'],
      evidence:
        'Independent AMCP read extension, official Reddit v3 schema; locally qualified, live verification pending.',
    };
  });
  return readRoutes;
}
const unscopedReads = new Set(['/api/v3/forecasting/bid_suggestions', '/api/v3/targeting/keyword_suggestions']);
/**
 * Bid and keyword suggestions have no account in their path. Bid suggestions name the selected ad account in
 * data.ad_account_id (the scope guard compares it); keyword suggestions are account-agnostic and run under a selected
 * bound account. Neither may carry an account-owned reference (a custom audience ID), so one login cannot ask about
 * another account's audiences.
 */
export function authorizeRedditPlanningRead(plan: CompiledRequest, _connection: Connection, account: string): boolean {
  if (plan.gateway !== 'reddit_native_action' || !plan.readOnly || plan.method !== 'POST') return false;
  let path: string;
  try {
    path = decodeURIComponent(plan.path);
  } catch {
    return false;
  }
  if (!unscopedReads.has(path)) return false;
  const data = (plan.body as JsonObject | undefined)?.data,
    targeting = data?.targeting;
  if (path === '/api/v3/forecasting/bid_suggestions' && data?.ad_account_id !== account)
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Name the selected ad account in data.ad_account_id for bid suggestions.',
      {},
      403,
    );
  if (Array.isArray(targeting?.custom_audience_ids) && targeting.custom_audience_ids.length)
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Bid suggestions here take no custom audience IDs: an audience belongs to one ad account. Remove custom_audience_ids.',
      {},
      403,
    );
  return true;
}
/** Whether a request reads an ad account's change history (its response names people). */
export function redditAccountHistoryRead(plan: Pick<CompiledRequest, 'gateway' | 'path' | 'method'>): boolean {
  return (
    plan.gateway === 'reddit_native_action' &&
    plan.method === 'POST' &&
    /^\/api\/v3\/ad_accounts\/[^/]+\/history$/.test(plan.path)
  );
}
/**
 * The change history without who made each change: member IDs, usernames, e-mails and full names are personal data
 * (personal-data policy) and are dropped before the response leaves the service. The change itself, its time and a
 * partner business name stay; `changed_by` says only whether Reddit named a member.
 */
export function projectRedditAccountHistory(data: unknown): unknown {
  const value = data as JsonObject;
  if (!value || typeof value !== 'object' || !Array.isArray(value.data)) return data;
  return {
    ...value,
    data: value.data.map((row: JsonObject) => {
      const cause = (row?.cause ?? {}) as JsonObject;
      return {
        change: row?.change ?? null,
        cause: {
          changed_at: cause.changed_at ?? null,
          partner_business_name: cause.partner_business_name ?? null,
          changed_by: ['member_id', 'reddit_username', 'email', 'fullname'].some(k => cause[k] != null)
            ? 'member_not_shown'
            : 'not_reported',
        },
      };
    }),
    personal_data: {member_identity: 'removed'},
  };
}
const ref = (name: string) => ({$ref: '#/components/schemas/' + name});
export const redditAudienceRoutes: VendorRoute[] = redditAudienceActions.map((action, i) => ({
  gateway: 'reddit_native_action',
  operation: 'reddit_account_ops',
  action,
  vendorMethod: i ? 'Update Saved Audience' : 'Create Saved Audience',
  source: 'https://ads-api.reddit.com/api/v3/openapi.json',
  sourceFile: 'reddit-v3',
  origin: 'https://ads-api.reddit.com',
  path: i ? '/api/v3/saved_audiences/{saved_audience_id}' : '/api/v3/ad_accounts/{ad_account_id}/saved_audiences',
  method: i ? 'PATCH' : 'POST',
  readOnly: false,
  parameters: {[i ? 'saved_audience_id' : 'ad_account_id']: {location: 'path', type: 'string', required: true}},
  bodyRequired: true,
  requestSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        additionalProperties: false,
        ...(i ? {} : {required: ['name', 'type', 'targeting']}),
        properties: {
          name: ref('name-4'),
          targeting: ref('targeting-2'),
          ...(i ? {status: ref('status-3')} : {type: {type: 'string', const: 'REDDIT_AUDIENCE'}}),
        },
      },
    },
  },
  responseSchemas: {
    [i ? '200' : '201']: {
      type: 'object',
      additionalProperties: false,
      properties: {data: ref('components_schema_saved_audience')},
    },
  },
  scopes: ['adsread', 'adsedit'],
  evidence: 'Independent AMCP extension, official Reddit v3 schema; locally qualified, live verification pending.',
}));
