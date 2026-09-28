import type {CallOptions, JsonObject, Action} from './types.js';
import {Registry} from './catalog.js';
import {MirrorError} from './errors.js';
export class Introspection {
  constructor(private registry: Registry) {}
  describe(gateway: string, input: JsonObject): JsonObject {
    const name = input.target_action;
    if (!name) throw new MirrorError('INVALID_ARGUMENT', 'target_action is required for DESCRIBE_ACTION.');
    const effective = this.registry.action(gateway, name);
    if (gateway === 'meta_native_action' && effective?.name === 'meta_ad_account_id_adlabels_get')
      return {
        success: true,
        api_version: 'v25.0',
        ...structuredClone(effective.raw),
        path: effective.path,
        mirror_evidence: effective.evidence,
        captured_mapping: structuredClone(effective.raw),
        source:
          'https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py',
      };
    const exact = this.registry.data.descriptions[gateway + '/' + name];
    if (exact) return structuredClone(exact);
    const action = this.registry.action(gateway, name);
    if (!action) throw new MirrorError('UNKNOWN_ACTION', 'Action is absent from the captured catalog.');
    return {
      success: true,
      api_version: this.registry.catalogs.get(gateway)?.api_version,
      ...structuredClone(action.raw),
      mirror_evidence: 'Catalog metadata only; extended DESCRIBE_ACTION response is unverified.',
    };
  }
  list(gateway: string, input: JsonObject, options: CallOptions): JsonObject {
    const catalog = this.registry.catalogs.get(gateway);
    if (!catalog) throw new MirrorError('UNKNOWN_GATEWAY', 'Unknown gateway.');
    if (catalog.denominator_kind !== 'LIST_ACTIONS')
      throw new MirrorError('CATALOG_UNAVAILABLE', 'This gateway does not expose a verified LIST_ACTIONS contract.');
    const enhanced = options.mode === 'enhanced';
    const uniform = enhanced && options.flags.catalogPagination;
    const definition = this.registry.tools.get(gateway)!;
    const schema = definition.inputSchema.properties;
    const nativeCap = schema.limit?.maximum ?? 100;
    const limit = Math.min(
      uniform ? 500 : nativeCap,
      Math.max(1, Number(input.limit ?? schema.limit?.default ?? (gateway === 'snapchat_native_action' ? 25 : 50))),
    );
    const offset = Number(
      uniform
        ? (input.offset ?? input.cursor ?? 0)
        : gateway === 'snapchat_native_action'
          ? (input.cursor ?? 0)
          : (input.offset ?? 0),
    );
    let all = catalog.actions;
    if (input.search) {
      const needle = String(input.search).toLowerCase();
      all = all.filter(a => JSON.stringify(a.raw).toLowerCase().includes(needle));
    }
    if (input.category)
      all = all.filter(a =>
        String(a.raw.category ?? '')
          .toLowerCase()
          .includes(String(input.category).toLowerCase()),
      );
    if (typeof input.read_only === 'boolean') all = all.filter(a => a.read_only === input.read_only);
    if (input.service)
      all = all.filter(a => String(a.raw.service ?? '').toLowerCase() === String(input.service).toLowerCase());
    if (input.surface && input.surface !== 'all') all = all.filter(a => a.raw.surface === input.surface);
    const actions = all.slice(offset, offset + limit).map(a => this.record(a, options));
    if (gateway === 'snapchat_native_action' && !(enhanced && options.flags.catalogEnvelope))
      return {
        actions,
        total: all.length,
        returned: actions.length,
        ...(offset + limit < all.length ? {next_cursor: offset + limit} : {}),
      };
    const result: JsonObject = {
      success: true,
      api_version: catalog.api_version,
      total_actions: all.length,
      offset,
      limit,
      has_more: offset + limit < all.length,
      actions,
    };
    if (gateway === 'google_ads_native_action') {
      result.rpc_action_count = catalog.actions.filter(a => a.raw.surface === 'rpc').length;
      result.legacy_action_count = catalog.actions.filter(a => a.raw.surface === 'legacy').length;
    }
    return result;
  }
  private record(action: Action, options: CallOptions) {
    let record = structuredClone(action.raw);
    if (options.mode !== 'enhanced') return record;
    if (options.flags.catalogFields) {
      record = {...record, name: action.name, canonical_action: action.canonical_name, path: action.path};
      delete record.action;
      delete record.endpoint;
    }
    if (options.flags.scopeMetadata) record.oauth_scopes ??= null;
    if (options.flags.confirmationMetadata) record.requires_confirmation ??= null;
    return record;
  }
}
