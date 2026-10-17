import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {metaRoute} from './meta-version.js';
import {MirrorError} from './errors.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/**
 * Meta's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a Graph batch is
 * never a read, and an account's value rule sets are a documented read whose path holds "set".
 */
export const metaHooks: ProviderHooks = Object.freeze({
  gateway: 'meta_native_action',
  reads: Object.freeze({
    batch: (key: string) => key === 'batch',
    // GET act_<id>/value_rule_set. The fixed act_ path binds it, so it has no authorizer of its own.
    qualifiedRead: (p: CompiledRequest) =>
      (!p.origin || p.origin === 'https://graph.facebook.com') && metaRoute('act_\\d+/value_rule_set$').test(p.path),
  }),
  paging: Object.freeze({
    nextPage(_plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      if (!d.paging?.next) return null;
      const cursor = d.paging?.cursors?.after;
      if (!cursor) throw new MirrorError('UNKNOWN_PAGINATION', 'Meta advertises another page but supplies no cursor.');
      next.query.after = cursor;
      return next;
    },
  }),
});
