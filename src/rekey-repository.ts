import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * The statements of a master-key rotation (SEC-07 S3, src/rekey.ts) in the store layer (ARC-02), moved here verbatim:
 * it pages through every table that holds sealed values by rowid and rewrites the values it re-seals. Table and column
 * names come from src/rekey.ts's own constants and are checked here; values are always bound parameters.
 */
const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Invalid table or column ' + JSON.stringify(name) + '.');
  return name;
};
/** Whether the database has the table (the website's tables are absent from an MCP-only store). */
export {tableExists as hasTable} from './owner-health-repository.js';
/** The next `size` rows of a table after the rowid `after` (rowid as `r`, then the named columns). */
export function rowsAfter(store: Store, table: string, columns: string, after: number, size: number): JsonObject[] {
  columns.split(',').forEach(identifier);
  return store
    .sql()
    .prepare('SELECT rowid AS r,' + columns + ' FROM ' + identifier(table) + ' WHERE rowid>? ORDER BY rowid LIMIT ?')
    .all(after, size) as JsonObject[];
}
/** Writes the named columns of one row, by rowid. */
export function updateRow(
  store: Store,
  table: string,
  update: Record<string, string | number | Buffer | null>,
  rowid: number,
) {
  const names = Object.keys(update).map(identifier);
  store
    .sql()
    .prepare('UPDATE ' + identifier(table) + ' SET ' + names.map(n => n + '=?').join(',') + ' WHERE rowid=?')
    .run(...(Object.values(update) as (string | number | Buffer | null)[]), rowid);
}
/** Every workspace id. */
export function tenantIds(store: Store): {id: string}[] {
  return store.sql().prepare('SELECT id FROM tenants').all() as {id: string}[];
}
