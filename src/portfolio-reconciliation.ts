import {MirrorError} from './errors.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {portfolioPage} from './portfolio.js';
import {normalizeAccount} from './scope.js';
import {fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {stable} from './security.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateways = [
  'google_ads_native_action',
  'meta_native_action',
  'linkedin_native_action',
  'snapchat_native_action',
  'tiktok_native_action',
  'x_ads_native_action',
];
function incomplete(message: string): never {
  throw new MirrorError('PORTFOLIO_RECONCILIATION_INCOMPLETE', message, {}, 422);
}
/** Two complete bounded observations of one native inventory selection. No atomic-snapshot or deletion claim. */
export async function reconcilePortfolio(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  validate(input, [
    'action',
    'gateway',
    'account_id',
    'connection_id',
    'requirements',
    'limit',
    'max_entities',
    'max_pages',
  ]);
  if (!gateways.includes(input.gateway))
    throw new MirrorError(
      'PORTFOLIO_UNQUALIFIED',
      'Choose a qualified inventory provider before comparing observations.',
    );
  const pageSize = input.limit ?? 50,
    maxEntities = input.max_entities ?? 500,
    maxPages = input.max_pages ?? 20;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isInteger(maxEntities) ||
    maxEntities < 1 ||
    maxEntities > 1000 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 25 ||
    !obj(input.requirements)
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Inventory comparison requires exact hierarchy settings and bounded page, entity and page-count limits.',
    );
  const gateway = input.gateway,
    account = normalizeAccount(gateway, input.account_id),
    connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const authorization = fingerprint({connection, credentials: store.connectionCredentials(connection)});
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({connection: c, credentials: store.connectionCredentials(c)}) !== authorization)
      throw new MirrorError(
        'REAUTHORIZATION_REQUIRED',
        'The inventory login or permissions changed. Start a new comparison.',
      );
  };
  const scope = {
    gateway,
    account_id: account,
    connection_id: connection.id,
    requirements: structuredClone(input.requirements),
    page_size: pageSize,
  };
  let usage: JsonObject = {};
  const budget = new ReportCollectionBudget(
    undefined,
    fingerprint({scope, maxEntities, maxPages}),
    value => {
      usage = value;
    },
    {requests: 120, rows: 2 * maxEntities, bytes: 32 * 1024 * 1024, elapsed_ms: 120000},
  );
  async function observe(pass: number) {
    const startedAt = Date.now(),
      rows = new Map<string, JsonObject>(),
      cursors = new Set<string>(),
      references: JsonObject[] = [];
    let cursor: string | undefined, entity: string | undefined, sourceContext: JsonObject | undefined;
    for (let page = 1; page <= maxPages; page++) {
      current();
      budget.check();
      const out = await portfolioPage(store, call, actor, {
        action: 'portfolio',
        gateway: scope.gateway,
        account_id: account,
        connection_id: connection.id,
        requirements: scope.requirements,
        limit: pageSize,
        ...(cursor ? {cursor} : {}),
      });
      current();
      budget.check();
      if (
        !obj(out) ||
        out.gateway !== scope.gateway ||
        out.account_id !== account ||
        out.connection_id !== connection.id ||
        typeof out.entity !== 'string' ||
        !Array.isArray(out.rows) ||
        out.rows.length > pageSize ||
        typeof out.has_more !== 'boolean' ||
        (entity !== undefined && entity !== out.entity)
      )
        incomplete('Inventory comparison received a conflicting page identity or collection.');
      entity = out.entity;
      if (!Number.isSafeInteger(out.captured_at) || out.captured_at < startedAt || out.captured_at > Date.now())
        incomplete('Inventory comparison did not retain a valid native observation time.');
      for (const row of out.rows) {
        if (!obj(row) || typeof row.id !== 'string' || !row.id || row.entity !== entity || rows.has(row.id))
          incomplete('Inventory comparison encountered a missing or repeated native entity identity.');
        const context = {currency: row.currency ?? null, timezone: row.timezone ?? null};
        if (sourceContext && fingerprint(context) !== fingerprint(sourceContext))
          incomplete('Inventory account currency or timezone changed within one observation.');
        sourceContext = context;
        rows.set(row.id, structuredClone(row));
      }
      if (rows.size > maxEntities)
        incomplete('Inventory comparison reached its entity limit before completing both observations.');
      budget.rows('observation-' + pass, rows.size);
      references.push({
        page,
        observed_at: out.captured_at,
        row_count: out.rows.length,
        page_sha256: fingerprint(out.rows),
      });
      if (!out.has_more) {
        if (out.next_cursor !== null && out.next_cursor !== undefined && out.next_cursor !== '')
          incomplete('Inventory comparison received a continuation on a terminal page.');
        const sorted = [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return {
          entity,
          rows: sorted,
          row_count: sorted.length,
          source_context: sourceContext ?? null,
          started_at: startedAt,
          completed_at: Date.now(),
          pages: references,
          content_sha256: fingerprint(sorted),
        };
      }
      if (
        typeof out.next_cursor !== 'string' ||
        !out.next_cursor ||
        out.next_cursor.length > 262144 ||
        cursors.has(out.next_cursor)
      )
        incomplete('Inventory comparison received an absent or repeated continuation.');
      cursors.add(out.next_cursor);
      cursor = out.next_cursor;
    }
    return incomplete('Inventory comparison reached its page limit before completing both observations.');
  }
  try {
    return await budget.run(async () => {
      const before = await observe(1),
        after = await observe(2);
      if (before.entity !== after.entity)
        incomplete('Inventory comparison changed its native entity type between observations.');
      const first = new Map(before.rows.map(row => [row.id, row])),
        second = new Map(after.rows.map(row => [row.id, row]));
      const added = after.rows.filter(row => !first.has(row.id)),
        missing = before.rows.filter(row => !second.has(row.id));
      const changed = after.rows
        .filter(row => first.has(row.id) && fingerprint(first.get(row.id)) !== fingerprint(row))
        .map(row => ({id: row.id, before: first.get(row.id), after: row}));
      current();
      budget.check();
      const result: JsonObject = {
        version: 1,
        record_kind: 'portfolio_reconciliation',
        scope,
        entity: after.entity,
        status: added.length || missing.length || changed.length ? 'changes_observed' : 'same_supported_fields',
        observations: [before, after].map(({rows, ...metadata}) => metadata),
        rows: after.rows,
        changes: {
          observed_added: added,
          not_observed_again: missing,
          supported_fields_changed: changed,
          unchanged_count: after.rows.length - added.length - changed.length,
        },
        coverage: {
          complete_within_selection: true,
          observations: 2,
          visibility: 'qualified_provider_inventory_defaults',
          atomic_snapshot: false,
          deleted_entity_inventory: false,
          absence_authorizes_delete: false,
          historical_assignment: false,
        },
        collection_usage: {...usage, active_since: null},
        provider_mutations: 0,
        saved_artifacts: 0,
        meaning:
          'Two complete sequential reads compare the supported fields of this exact inventory selection. Matching observations do not prove an atomic snapshot or unchanged intervening state. A missing row means it was not observed again under the provider visibility rules; it does not establish deletion or authorize removal.',
      };
      if (Buffer.byteLength(stable(result)) > 2 * 1024 * 1024)
        incomplete(
          'Inventory comparison exceeded its result-size limit. Narrow the selected hierarchy or entity limit.',
        );
      return result;
    });
  } finally {
    budget.close();
  }
}
