import type {SQLInputValue} from 'node:sqlite';
import type {Store} from './store.js';
import {
  documentKind,
  documentProblems,
  expiredCondition,
  fieldPath,
  isServicePartition,
  servicePartitionOf,
  unexpiredCondition,
  type DocumentKind,
  type DocumentKindName,
} from './document-kinds.js';
import type {JsonObject} from './types.js';

/** A document as the store returns it: its payload with its id and revision. */
export type StoredDocument = JsonObject & {id: string; revision: number};
export interface SelectOptions {
  /** Result columns; defaults to `id,data,revision`, which `select` decodes into stored documents. */
  columns?: string;
  order?: string;
  limit?: number;
}

/**
 * A condition, assignment, column list or order a store-layer module passes to a repository statement must stay inside
 * the binding it is wrapped in: balanced parentheses, and no statement separator or comment, outside its quoted
 * literals and identifiers. Otherwise a text such as `1) OR (1=1` would close the workspace binding and reach every
 * workspace. A programming error, refused before the statement is prepared.
 */
export function assertBoundFragment(text: string, part: string): void {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      // A quoted literal or identifier ends at its next unpaired quote ('' and "" escape one).
      let j = i + 1;
      while (j < text.length && !(text[j] === c && text[j + 1] !== c)) j += text[j] === c ? 2 : 1;
      if (j >= text.length) throw new Error('A repository ' + part + ' has an unterminated quote.');
      i = j;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth < 0)
      throw new Error('A repository ' + part + ' closes a parenthesis it did not open.');
    else if (c === ';' || (c === '-' && text[i + 1] === '-') || (c === '/' && text[i + 1] === '*'))
      throw new Error('A repository ' + part + ' holds a statement separator or a comment.');
  }
  if (depth !== 0) throw new Error('A repository ' + part + ' leaves a parenthesis open.');
}

/**
 * The documents of one kind in one workspace, or of one service kind (ARC-02). Every statement it runs is bound to its
 * workspace (or service partition) and kind: `tenant_id=? AND kind=?` is part of the statement, so one workspace's
 * repository cannot read, change or delete another's documents. Reads and writes of single documents use the store's
 * own document methods (revisions, transactions and the NOT_FOUND refusal stay as they are); `select`, `count`,
 * `deleteWhere` and `updateWhere` take a condition written by a store-layer repository module (src/*-repository.ts),
 * which tools/check-storage-boundary.mjs keeps out of every other module. Such a condition must be balanced: one that
 * would leave the binding (unbalanced parentheses, a `;`, `--` or `/*`) is refused before the statement is prepared
 * (assertBoundFragment), and its values are bound, never written into the text.
 */
export class DocumentRepository<K extends DocumentKindName = DocumentKindName> {
  readonly kind: K;
  /** The workspace id, or the service partition id, every statement is bound to. */
  readonly tenant: string;
  readonly spec: DocumentKind;
  constructor(
    private readonly store: Store,
    kind: K,
    scope: {tenant: string} | {service: true},
  ) {
    const spec = documentKind(kind);
    if ('service' in scope) {
      if (spec.scope !== 'service')
        throw new Error('Document kind ' + kind + ' belongs to a workspace: use store.repo.');
      this.tenant = servicePartitionOf(kind);
    } else {
      if (spec.scope !== 'tenant')
        throw new Error('Document kind ' + kind + ' belongs to the service: use store.serviceRepo.');
      if (typeof scope.tenant !== 'string' || !scope.tenant || isServicePartition(scope.tenant))
        throw new Error('A document repository needs a workspace id, not ' + JSON.stringify(scope.tenant) + '.');
      this.tenant = scope.tenant;
    }
    this.kind = kind;
    this.spec = spec;
  }
  /** The document, or NOT_FOUND (404) as `Store.document`. */
  get(id: string): StoredDocument {
    return this.store.document(this.tenant, this.kind, id) as StoredDocument;
  }
  /** The document, or undefined when it does not exist. */
  find(id: string): StoredDocument | undefined {
    const row = this.store
      .sql()
      .prepare('SELECT data,revision FROM documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenant, this.kind, id) as {data: string; revision: number} | undefined;
    return row ? ({...JSON.parse(row.data), id, revision: row.revision} as StoredDocument) : undefined;
  }
  /** The stored JSON text of the document, unparsed (for a reader that validates it itself), or undefined. */
  text(id: string): string | undefined {
    const row = this.store
      .sql()
      .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenant, this.kind, id) as {data: string} | undefined;
    return row?.data;
  }
  /** The stored JSON texts of the listed documents that exist, unparsed, in no particular order. */
  texts(ids: readonly string[]): {id: string; data: string}[] {
    if (!ids.length) return [];
    return this.select('id IN (' + ids.map(() => '?').join(',') + ')', [...ids], {columns: 'id,data'}) as {
      id: string;
      data: string;
    }[];
  }
  /** The document's payload alone (without its id and revision), or undefined when it does not exist. */
  payload(id: string): JsonObject | undefined {
    const row = this.store
      .sql()
      .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenant, this.kind, id) as {data: string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  /** One payload field of the document as SQLite reads it (json_extract), or undefined when the document is absent. */
  field(id: string, name: string): unknown {
    const [row] = this.select('id=?', [id], {columns: 'json_extract(data,' + fieldPath(name) + ') AS value'});
    return row ? row.value : undefined;
  }
  /** The payload of the document with the largest whole number in `field` (ties by id), or undefined when none. */
  newest(field: string): JsonObject | undefined {
    const [row] = this.select('', [], {
      columns: 'data',
      order: 'CAST(json_extract(data,' + fieldPath(field) + ') AS INTEGER) DESC,id',
      limit: 1,
    });
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  /** The total of the numbers in a payload field over this workspace's documents of the kind (0 when none). */
  sum(field: string): number {
    const [row] = this.select('', [], {columns: 'coalesce(sum(json_extract(data,' + fieldPath(field) + ')),0) AS n'});
    return row!.n as number;
  }
  /** The documents whose payload field (a name, or dotted names) equals `value`, by id. */
  findBy(field: string, value: SQLInputValue): StoredDocument[] {
    return this.select('json_extract(data,' + fieldPath(field) + ')=?', [value], {order: 'id'}) as StoredDocument[];
  }
  /** Deletes the documents whose payload field equals `value`; how many. */
  deleteBy(field: string, value: SQLInputValue): number {
    return this.deleteWhere('json_extract(data,' + fieldPath(field) + ')=?', [value]);
  }
  private expiry() {
    const r = this.spec.retention;
    if (r.rule !== 'expires' || r.by !== 'owner_module')
      throw new Error(
        'Document kind ' + this.kind + ' has no expiry its owner module applies (src/document-kinds.ts).',
      );
    return r;
  }
  /**
   * Applies the kind's declared expiry (`retention` in src/document-kinds.ts, `by: 'owner_module'`) at `now`: deletes the
   * documents of this workspace past their deadline. How many.
   */
  purgeExpired(now: number): number {
    return this.deleteWhere(expiredCondition(this.expiry()), [now]);
  }
  /** How many documents of this workspace and kind are not yet past their declared deadline at `now`. */
  countUnexpired(now: number): number {
    return this.count(unexpiredCondition(this.expiry()), [now]);
  }
  /**
   * Keeps the newest `limit` documents whose `field` equals `value`, newest by the number in `orderField` (absent counts
   * as 0) and then by when they were first written, and deletes the others with that value. How many went.
   */
  keepNewest(field: string, value: SQLInputValue, orderField: string, limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('keepNewest needs a whole limit.');
    const match = 'json_extract(data,' + fieldPath(field) + ')=?';
    return this.deleteWhere(
      match +
        ' AND id NOT IN (SELECT id FROM documents WHERE tenant_id=? AND kind=? AND ' +
        match +
        ' ORDER BY coalesce(json_extract(data,' +
        fieldPath(orderField) +
        '),0) DESC, rowid DESC LIMIT ?)',
      [value, this.tenant, this.kind, value, limit],
    );
  }
  /** Deletes the document only at this revision (unchanged since it was read); whether it was deleted. */
  deleteRevision(id: string, revision: number): boolean {
    return this.deleteWhere('id=? AND revision=?', [id, revision]) > 0;
  }
  /**
   * Each document's id and the named top-level payload fields (as SQLite reads them), oldest first by the number in
   * `clock` (absent counts as 0), then by id.
   */
  fieldsByAge(fields: readonly string[], clock: string): JsonObject[] {
    const columns = fields.map(f => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f)) throw new Error('Invalid document field ' + JSON.stringify(f) + '.');
      return 'json_extract(data,' + fieldPath(f) + ') AS ' + f;
    });
    return this.select('', [], {
      columns: ['id', ...columns].join(','),
      order: 'coalesce(json_extract(data,' + fieldPath(clock) + '),0),id',
    });
  }
  /** Whether the document exists, without reading its payload. */
  has(id: string): boolean {
    return !!this.store
      .sql()
      .prepare('SELECT 1 FROM documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenant, this.kind, id);
  }
  /** The documents whose id is at least `from` and below `to`, by id (an id prefix range, for example). */
  range(from: string, to: string): StoredDocument[] {
    return (
      this.store
        .sql()
        .prepare('SELECT id,data,revision FROM documents WHERE tenant_id=? AND kind=? AND id>=? AND id<? ORDER BY id')
        .all(this.tenant, this.kind, from, to) as {id: string; data: string; revision: number}[]
    ).map(r => ({...JSON.parse(r.data), id: r.id, revision: r.revision}) as StoredDocument);
  }
  /** Deletes the documents whose id is at least `from` and below `to`; how many. */
  deleteRange(from: string, to: string): number {
    return Number(
      this.store
        .sql()
        .prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id>=? AND id<?')
        .run(this.tenant, this.kind, from, to).changes,
    );
  }
  /** Every document of the kind, by id (as `Store.documents`). */
  list(): StoredDocument[] {
    return this.store.documents(this.tenant, this.kind) as StoredDocument[];
  }
  /**
   * Writes the document as `Store.putDocument` (an expected revision of 0: it must not exist yet). The payload must keep
   * the kind's store contract (`fields` in src/document-kinds.ts), so retention and erasure can rely on it. A payload
   * that breaks it is a programming error of the module that built it (callers validate what a person sends before
   * building a document), so it is a plain Error, never a refusal a person is asked to correct.
   */
  put(id: string, data: JsonObject, expectedRevision?: number) {
    const problems = documentProblems(this.kind, data);
    if (problems.length) throw new Error('Document breaks its store contract: ' + problems.join(' '));
    return this.store.putDocument(this.tenant, this.kind, id, data, expectedRevision);
  }
  /** Deletes the document; whether one was deleted. */
  delete(id: string): boolean {
    return (
      Number(
        this.store
          .sql()
          .prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=?')
          .run(this.tenant, this.kind, id).changes,
      ) > 0
    );
  }
  private bound(where?: string) {
    if (where) assertBoundFragment(where, 'condition');
    return 'FROM documents WHERE tenant_id=? AND kind=?' + (where ? ' AND (' + where + ')' : '');
  }
  /**
   * The documents of this workspace and kind that match `where` (store-layer repositories only). With the default
   * columns each row is decoded into a stored document; other columns are returned as SQLite returns them.
   */
  select(where = '', params: SQLInputValue[] = [], options: SelectOptions = {}): JsonObject[] {
    // Placeholders bind in order and the binding comes first, so the columns and order take none.
    if (/\?/.test((options.columns ?? '') + (options.order ?? '')))
      throw new Error('Pass values to select through its condition, not its columns or order.');
    if (options.columns !== undefined) assertBoundFragment(options.columns, 'column list');
    if (options.order !== undefined) assertBoundFragment(options.order, 'order');
    const sql =
      'SELECT ' +
      (options.columns ?? 'id,data,revision') +
      ' ' +
      this.bound(where) +
      (options.order ? ' ORDER BY ' + options.order : '') +
      (options.limit !== undefined ? ' LIMIT ' + Math.max(0, Math.trunc(options.limit)) : '');
    const rows = this.store
      .sql()
      .prepare(sql)
      .all(this.tenant, this.kind, ...params) as JsonObject[];
    return options.columns === undefined
      ? rows.map(r => ({...JSON.parse(String(r.data)), id: r.id, revision: r.revision}))
      : rows;
  }
  /** How many documents of this workspace and kind match `where`. */
  count(where = '', params: SQLInputValue[] = []): number {
    return Number(
      (
        this.store
          .sql()
          .prepare('SELECT count(*) AS n ' + this.bound(where))
          .get(this.tenant, this.kind, ...params) as {n: number}
      ).n,
    );
  }
  /** Deletes the documents of this workspace and kind that match `where`; how many. */
  deleteWhere(where: string, params: SQLInputValue[] = []): number {
    if (!where.trim()) throw new Error('deleteWhere needs a condition; delete documents one by one with delete(id).');
    return Number(
      this.store
        .sql()
        .prepare('DELETE ' + this.bound(where))
        .run(this.tenant, this.kind, ...params).changes,
    );
  }
  /**
   * Rewrites the documents of this workspace and kind that match `where`: `set` assigns `data` with its own values,
   * and each revision advances. How many.
   */
  updateWhere(set: string, setParams: SQLInputValue[], where: string, whereParams: SQLInputValue[] = []): number {
    if (!where.trim()) throw new Error('updateWhere needs a condition.');
    assertBoundFragment(set, 'assignment');
    assertBoundFragment(where, 'condition');
    return Number(
      this.store
        .sql()
        .prepare(
          'UPDATE documents SET ' + set + ',revision=revision+1 WHERE tenant_id=? AND kind=? AND (' + where + ')',
        )
        .run(...setParams, this.tenant, this.kind, ...whereParams).changes,
    );
  }
}
