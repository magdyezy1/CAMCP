import type {VendorRoute} from './delegated-native.js';
import type {ToolDefinition} from './types.js';

// Independent AMCP extensions from Reddit's published v3 OpenAPI contract.
// Keep the captured AMCP registry and its denominators unchanged.
export const redditAudienceActions = ['CREATE_SAVED_AUDIENCE', 'UPDATE_SAVED_AUDIENCE'];
export function extendRedditTool(original: ToolDefinition): ToolDefinition {
  const tool = structuredClone(original),
    op = tool.operations?.find(o => o.operation === 'reddit_account_ops');
  if (op) {
    op.argumentsSchema.properties.action.enum.push(...redditAudienceActions);
    op.argumentsSchema.properties.action.description =
      'Captured account actions plus independent AMCP saved-audience create/update extensions.';
  }
  return tool;
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
