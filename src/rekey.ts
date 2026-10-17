import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {scopeKey, stable} from './security.js';
import {storableCredentials} from './app-credentials.js';
import type {Credentials, JsonObject} from './types.js';
import {hasTable, rowsAfter, tenantIds, updateRow} from './rekey-repository.js';

/**
 * Master-key rotation (SEC-07 S3). With the new key in MIRROR_MASTER_KEY and the replaced one in
 * MIRROR_MASTER_KEY_PREVIOUS, every value opens with either key and new values are sealed with the new one. `rekey`
 * re-seals every stored value that still opens only with a previous key under the current key, so the previous key can
 * then be removed; `--dry-run` counts which key opens each value and writes nothing.
 *
 * Every sealed location is listed here. The scope (the AES-GCM associated data) of a value inside a document or job is
 * not stored with it, so it is found among the scopes the application seals with: the containing record's id and the
 * `id` and `review_id` of the objects around the value, under every purpose below. A value no scope opens is counted
 * `unreadable` and left untouched; the report then says the rotation is incomplete. tests/rekey.test.ts keeps these
 * lists equal to what the source seals.
 */
/** Prefixes of the ids job-actor bindings are sealed for (Store.bindJobActor callers). */
export const jobActorPrefixes = [
  '',
  'job:',
  'monitor:',
  'monitor-subscription:',
  'reporting-schedule:',
  'media-job:',
  // DEC-02: the background outcome review of an allocation plan (allocation-outcome.ts).
  'allocation-outcome:',
] as const;
/** Purposes of Store.sealValue and Store.sealMediaChunk. */
export const sealedValuePurposes = [
  'media-thumbnail',
  'report-file',
  'retained-media-manifest',
  'retained-media-chunk',
  'woocommerce-setup',
] as const;
/** Store kinds sealed as scopeKey(tenant, kind, id) inside documents. */
export const sealedDocumentScopes = ['upload-session', 'preview-receipt', 'x-report-result'] as const;
/** The scope kinds of values sealed into columns, by table (see the visitors below). */
export const sealedColumnScopes = [
  'media',
  'media-reservation',
  // The sealed description of a cached fitted copy (MED-03 C), in media_staging.reservation.
  'media-fit-cache',
  'media-chunk',
  'media-chunk-v2',
  'sealed-bytes',
  'mcp-client',
  'account-auth',
  'website-oauth',
] as const;
/** The shape of `SecretBox.seal` output: base64 IV (12 bytes), tag (16 bytes) and ciphertext. */
const sealShape = /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]*={0,2}$/;
/** Which scopes to try first in a document of a kind; every other candidate is tried after them. */
const documentHints: Record<string, (tenant: string, id: string) => string[]> = {
  upload_session: (t, id) => [scopeKey(t, 'upload-session', id)],
  preview_receipt: (t, id) => [scopeKey(t, 'preview-receipt', id)],
  x_report_result: (t, id) => [scopeKey(t, 'x-report-result', id)],
  report_file: (t, id) => [scopeKey(t, 'sealed-value', 'report-file', id)],
  website_connection: (t, id) => [scopeKey(t, 'sealed-value', 'woocommerce-setup', id)],
};

export interface RekeyTally {
  /** Values already sealed with the current key. */
  current: number;
  /** Values that open only with a previous key (dry run), or that were re-sealed with the current key. */
  previous: number;
  resealed: number;
  /** Values no key opens under any scope: left untouched. */
  unreadable: number;
  /** Connections only: copies of deployment app secrets removed (SEC-07 S2). */
  app_secrets_removed?: number;
}
export interface RekeyOptions {
  /** Count which key opens each value; write nothing. */
  dryRun?: boolean;
  /** Workspaces an AI-client registration may be sealed for (the website's AMCP_TENANT_ID); every workspace is tried. */
  websiteTenants?: readonly string[];
  /** Rows per transaction for record tables (default 50); media chunks always go one per transaction (OPS-01). */
  batch?: number;
}

export function rekeyStore(store: Store, options: RekeyOptions = {}): JsonObject {
  const box = store.keyring;
  if (!box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Set MIRROR_MASTER_KEY before re-sealing stored values.');
  const dryRun = options.dryRun === true,
    batch = Math.max(1, Math.min(1000, options.batch ?? 50)),
    locations: Record<string, RekeyTally> = {},
    has = (table: string) => hasTable(store, table),
    tally = (name: string) => (locations[name] ??= {current: 0, previous: 0, resealed: 0, unreadable: 0});
  const openText = (sealed: string, scopes: readonly string[]) => {
    for (const scope of scopes)
      try {
        return {...box.openWithKey<unknown>(sealed, scope), scope};
      } catch {
        /* The next scope. */
      }
  };
  /** The value to write instead of `sealed`, or undefined when it stays (already current, dry run or unreadable). */
  const text = (name: string, sealed: string, scopes: readonly string[]): string | undefined => {
    const t = tally(name),
      opened = openText(sealed, scopes);
    if (!opened) {
      t.unreadable++;
      return;
    }
    if (opened.key === 0) {
      t.current++;
      return;
    }
    t.previous++;
    if (dryRun) return;
    t.resealed++;
    return box.seal(opened.value, opened.scope);
  };
  const bytes = (name: string, sealed: Uint8Array, scope: string): Buffer | undefined => {
    const t = tally(name);
    let opened: {value: Buffer; key: number};
    try {
      opened = box.openBytesWithKey(sealed, scope);
    } catch {
      t.unreadable++;
      return;
    }
    if (opened.key === 0) {
      t.current++;
      return;
    }
    t.previous++;
    if (dryRun) return;
    t.resealed++;
    return box.sealBytes(opened.value, scope);
  };
  /** Pages through a table by rowid; each page's updates commit together. */
  const eachRow = (
    table: string,
    columns: string,
    visit: (row: JsonObject) => Record<string, string | number | Buffer | null> | undefined,
    size = batch,
  ) => {
    if (!has(table)) return;
    let after = Number.MIN_SAFE_INTEGER;
    for (;;) {
      const rows = rowsAfter(store, table, columns, after, size);
      if (!rows.length) return;
      after = rows.at(-1)!.r;
      const apply = () => {
        for (const row of rows) {
          const update = visit(row);
          if (!update || dryRun) continue;
          updateRow(store, table, update, row.r);
        }
      };
      if (dryRun) apply();
      else store.transaction(apply);
    }
  };
  /** Candidate scopes of a value inside a JSON record of a workspace, `preferred` first. */
  const candidates = (tenant: string, ids: readonly string[], preferred: readonly string[]) => {
    const out = [...preferred];
    for (const id of new Set(ids)) {
      for (const prefix of jobActorPrefixes) out.push(scopeKey(tenant, 'job-actor', prefix + id));
      for (const purpose of sealedValuePurposes) out.push(scopeKey(tenant, 'sealed-value', purpose, id));
      for (const kind of sealedDocumentScopes) out.push(scopeKey(tenant, kind, id));
    }
    return [...new Set(out)];
  };
  /** Re-seals every sealed string inside a JSON value in place; returns whether anything changed. */
  const json = (name: string, tenant: string, root: string, value: unknown, preferred: readonly string[]) => {
    let changed = false;
    const walk = (node: unknown, ids: readonly string[]): unknown => {
      if (typeof node === 'string') {
        if (!sealShape.test(node)) return node;
        const next = text(name, node, candidates(tenant, ids, preferred));
        if (next === undefined) return node;
        changed = true;
        return next;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = walk(node[i], ids);
        return node;
      }
      if (node && typeof node === 'object') {
        const record = node as JsonObject,
          local = [...ids];
        for (const field of ['id', 'review_id'])
          if (typeof record[field] === 'string' && record[field]) local.push(record[field]);
        for (const key of Object.keys(record)) record[key] = walk(record[key], local);
      }
      return node;
    };
    walk(value, [root]);
    return changed;
  };

  // Connections: re-sealed in the current format, without copies of the deployment's app secrets (SEC-07 S2). A
  // re-encryption is the same login, so the login revision and readiness evidence stay.
  eachRow('connections', 'tenant_id,id,data,secret', row => {
    const t = tally('connections'),
      legacy = !String(row.secret).startsWith('v2:'),
      scope = scopeKey(row.tenant_id, row.id),
      opened = openText(legacy ? row.secret : String(row.secret).slice(3), [
        legacy ? row.tenant_id + '/' + row.id : scope,
      ]);
    if (!opened) {
      t.unreadable++;
      return;
    }
    const credentials = opened.value as Credentials,
      storable = storableCredentials(JSON.parse(row.data).gateway, credentials, store.appEnvironment),
      stripped = stable(storable) !== stable(credentials);
    if (stripped) t.app_secrets_removed = (t.app_secrets_removed ?? 0) + 1;
    if (opened.key === 0) t.current++;
    else t.previous++;
    if (opened.key === 0 && !legacy && !stripped) return;
    if (dryRun) return;
    if (opened.key !== 0) t.resealed++;
    return {secret: 'v2:' + box.seal(storable, scope)};
  });
  eachRow('media_staging', 'tenant_id,id,secret,reservation', row => {
    const update: Record<string, string> = {};
    if (typeof row.secret === 'string') {
      const next = text('media_staging', row.secret, [scopeKey(row.tenant_id, 'media', row.id)]);
      if (next) update.secret = next;
    }
    if (typeof row.reservation === 'string') {
      // An upload's declared reservation, or a cached fitted copy's sealed description (MED-03 C).
      const next = text('media_staging', row.reservation, [
        scopeKey(row.tenant_id, 'media-reservation', row.id),
        scopeKey(row.tenant_id, 'media-fit-cache', row.id),
      ]);
      if (next) update.reservation = next;
    }
    return Object.keys(update).length ? update : undefined;
  });
  // Chunks may each be 4 MiB: one per transaction keeps the log small (OPS-01).
  const chunk = (table: string, v1: (row: JsonObject) => string, v2: (row: JsonObject) => string) =>
    eachRow(
      table,
      'tenant_id,id,chunk_index,secret',
      row => {
        const next =
          row.secret instanceof Uint8Array ? bytes(table, row.secret, v2(row)) : text(table, row.secret, [v1(row)]);
        return next === undefined ? undefined : {secret: next};
      },
      1,
    );
  chunk(
    'media_chunks',
    row => scopeKey(row.tenant_id, 'media-chunk', row.id, String(row.chunk_index)),
    row => scopeKey(row.tenant_id, 'media-chunk-v2', row.id, String(row.chunk_index)),
  );
  chunk(
    'retained_media_chunks',
    row => scopeKey(row.tenant_id, 'sealed-value', 'retained-media-chunk', row.id + '.' + row.chunk_index),
    row => scopeKey(row.tenant_id, 'sealed-bytes', 'retained-media-chunk', row.id + '.' + row.chunk_index),
  );
  eachRow('retained_media', 'tenant_id,id,secret', row => {
    const next = text('retained_media', row.secret, [
      scopeKey(row.tenant_id, 'sealed-value', 'retained-media-manifest', row.id),
    ]);
    return next === undefined ? undefined : {secret: next};
  });
  // Documents: a re-sealed document gets a new revision, so a writer holding the old one refuses instead of
  // writing the previous key's value back.
  eachRow('documents', 'tenant_id,kind,id,data,revision', row => {
    const data = JSON.parse(row.data);
    if (!json('documents', row.tenant_id, row.id, data, documentHints[row.kind]?.(row.tenant_id, row.id) ?? [])) return;
    return {data: JSON.stringify(data), revision: Number(row.revision) + 1};
  });
  eachRow('jobs', 'tenant_id,id,input,result', row => {
    const update: Record<string, string> = {};
    for (const column of ['input', 'result'] as const) {
      if (typeof row[column] !== 'string') continue;
      const value = JSON.parse(row[column]);
      if (json('jobs', row.tenant_id, row.id, value, [])) update[column] = JSON.stringify(value);
    }
    return Object.keys(update).length ? update : undefined;
  });
  const workspaces = [...new Set([...(options.websiteTenants ?? []), 'local', ...tenantIds(store).map(t => t.id)])];
  eachRow('amcp_mcp_clients', 'id,data', row => {
    const data = JSON.parse(row.data);
    if (typeof data.encrypted_client_secret !== 'string') return;
    const next = text(
      'amcp_mcp_clients',
      data.encrypted_client_secret,
      workspaces.map(t => scopeKey('mcp-client', t, row.id)),
    );
    if (next === undefined) return;
    data.encrypted_client_secret = next;
    return {data: JSON.stringify(data)};
  });
  const account = (table: string, columns: string, scope: (row: JsonObject) => string) =>
    eachRow(table, columns + ',secret', row => {
      if (typeof row.secret !== 'string' || !row.secret) return;
      const next = text(table, row.secret, [scopeKey('account-auth', scope(row))]);
      return next === undefined ? undefined : {secret: next};
    });
  account('amcp_mfa', 'user_id', row => 'mfa:' + row.user_id);
  account('amcp_account_challenges', 'hash', row => row.hash);
  account('amcp_email_outbox', 'id', row => 'mail:' + row.id);
  eachRow('amcp_oauth_states', 'hash,secret', row => {
    const next = text('amcp_oauth_states', row.secret, [scopeKey('website-oauth', row.hash)]);
    return next === undefined ? undefined : {secret: next};
  });

  const totals: RekeyTally = {current: 0, previous: 0, resealed: 0, unreadable: 0};
  for (const t of Object.values(locations))
    for (const key of ['current', 'previous', 'resealed', 'unreadable'] as const) totals[key] += t[key];
  const status = dryRun
    ? totals.previous || totals.unreadable
      ? 'pending'
      : 'complete'
    : totals.unreadable
      ? 'incomplete'
      : 'rekeyed';
  if (!dryRun)
    for (const tenant of tenantIds(store))
      store.appendAudit(tenant.id, 'admin/rekey', {
        event: 'secrets_rekeyed',
        status,
        resealed: totals.resealed,
        unreadable: totals.unreadable,
      });
  return {
    status,
    dry_run: dryRun,
    keys: box.keyCount,
    totals,
    locations,
    next_steps:
      status === 'complete' || status === 'rekeyed'
        ? [
            'Every stored value opens with the current key. Take a new backup, then remove MIRROR_MASTER_KEY_PREVIOUS and redeploy.',
            'Keep the previous key in the secret manager while backups taken before this rekey are kept: restoring one needs it.',
          ]
        : [
            'Keep MIRROR_MASTER_KEY_PREVIOUS: some values still need it, or open with no configured key.',
            'Run `admin rekey` (without --dry-run) to re-seal them; values counted unreadable need the key they were sealed with.',
          ],
  };
}
