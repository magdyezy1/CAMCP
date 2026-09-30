import type {Action} from './types.js';
import {metaPrefix} from './meta-version.js';

/**
 * Meta's documented rule update and delete (Ad Rules Engine "API Calls", read 2026-09-30: POST /{ad_rule_id} and DELETE
 * /{ad_rule_id}; Business SDK 26.0 AdRule api_update and api_delete). The captured catalog maps only rule creation, so
 * AMCP maps these two itself; src/meta-ad-rules.ts reviews them.
 */
const gateway = 'meta_native_action',
  source = 'https://developers.facebook.com/docs/marketing-api/ad-rules/guides/api-calls/';
function ruleRoute(name: string, method: string): Action {
  const path = metaPrefix + '{ad_rule_id}';
  return {
    gateway,
    name,
    canonical_name: name,
    aliases: [],
    method,
    path,
    read_only: false,
    destructive: method === 'DELETE',
    required: ['ad_rule_id'],
    path_parameters: ['ad_rule_id'],
    evidence: 'VENDOR_DOCUMENTED_NOT_AMCP_VERIFIED',
    raw: {
      name,
      canonical_action: name,
      method,
      path,
      category: 'Marketing API / ad-rules/guides/api-calls',
      read_only: false,
      destructive: method === 'DELETE',
      access_management: false,
      path_parameters: ['ad_rule_id'],
      required_parameters: ['ad_rule_id'],
      native_fields: [],
      source,
    },
  } as unknown as Action;
}
export const metaRuleActions: Action[] = [
  ruleRoute('meta_ad_rule_id_update', 'POST'),
  ruleRoute('meta_ad_rule_id_delete', 'DELETE'),
];
