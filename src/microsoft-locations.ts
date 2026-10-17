import {createGunzip, createInflateRaw, crc32} from 'node:zlib';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import {microsoftEvidence, templateFields} from './microsoft-evidence.js';
import {
  microsoftCustomer,
  microsoftGateway,
  microsoftGeoLocationsContract as contract,
  microsoftOrigin,
} from './microsoft-native.js';
import {nativeAuthority} from './native-authority.js';
import {publicGet, reportUrl} from './microsoft-report-download.js';

/**
 * The Microsoft location lookup (CMP-03): location IDs and names from Microsoft's geographical locations file, for the
 * positive location criteria of the microsoft_search pack. It reads; it saves nothing and changes no account.
 *
 * What it relies on, from the pinned evidence in .mirror/VENDOR:
 * - The Campaign Management WSDL: GetGeoLocationsFileUrl takes Version, LanguageLocale and CompressionType (Zip or GZip)
 *   and returns FileUrl, FileUrlExpiryTimeUtc and LastModifiedTimeUtc.
 * - The geographical location codes guide (pinned by digest; its rules are in tools/microsoft-rest.mjs): a location
 *   criterion takes the file's Location Id column, the Bing Display Name is for presentation only and several IDs can
 *   share one, a deprecated location cannot be added, and the guide and the LocationCriterion page disagree on when a
 *   Pending Deprecation location stops targeting.
 * - AMCP sends a Microsoft request only as Microsoft Learn's REST page documents it (F-50). The GetGeoLocationsFileUrl
 *   page is an optional pin (document.optional_operations of the REST evidence), which tools/microsoft-rest.mjs records
 *   when the owner runs it. Until it is pinned, the lookup refuses before anything is sent.
 *
 * Not confirmed until an owner-authorized native read: the file version AMCP asks for (2.0), the columns it reads when
 * present (Location Type, Status) and their values, the file's size, and whether Microsoft compresses it as asked. A
 * column AMCP does not find stays unknown (null) and is never inferred; the response names the columns it found.
 *
 * Bounds: the archive Microsoft's URL serves (public HTTPS, no credentials, no redirects, at most 32 MiB) is kept in
 * memory for an hour, one copy per deployment, since it is Microsoft's reference file and the same for every account;
 * each lookup still checks the person's own access. Every lookup streams it through inflate and CSV parsing (at most
 * 128 MiB of text and 1,000,000 rows) and returns at most 20 matches or 100 IDs, refusing instead of truncating.
 */
const version = '2.0',
  languageLocale = 'en',
  compressionType = 'Zip',
  pin = '.mirror/VENDOR/microsoft-rest-v13.json';
export const microsoftLocationLimits = Object.freeze({
  archive_bytes: 32 * 1024 * 1024,
  text_bytes: 128 * 1024 * 1024,
  rows: 1_000_000,
  field_characters: 1024,
  results: 20,
  ids: 100,
  fresh_ms: 60 * 60 * 1000,
  download_ms: 60_000,
});
const limits = microsoftLocationLimits;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numericId = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
/** A file AMCP cannot read completely; `problem` names the exact check that failed. */
function unreadable(message: string, problem: string): never {
  throw new MirrorError('MICROSOFT_LOCATIONS_FILE_INVALID', message, {problem}, 502);
}
/** The refusal when the deployment cannot send the file URL request as Microsoft Learn documents it. */
export function microsoftLocationsUnpinned(): MirrorError {
  return new MirrorError(
    'MICROSOFT_LOCATIONS_UNPINNED',
    'Microsoft location search is not available in this deployment yet: AMCP sends a Microsoft request only as Microsoft Learn documents it, and the request for the geographical locations file is not pinned. Enter the location IDs instead; activation preflight lists each location with the name Microsoft gives it.',
    {operation: contract.name, page: contract.page},
    409,
  );
}

/**
 * The REST request Microsoft Learn documents for GetGeoLocationsFileUrl, from the optional pin. Without it, or when the
 * page documents another method, URL or fields, the lookup refuses before anything is sent.
 */
export function geoLocationsRest(envelope: JsonObject = pinnedJson(pin)): JsonObject {
  const op = envelope?.document?.optional_operations?.[contract.name];
  if (!obj(op)) throw microsoftLocationsUnpinned();
  let request: string[] = [],
    response: string[] = [];
  try {
    request = templateFields(op.request_json);
    response = templateFields(op.response_json);
  } catch {
    // An unreadable template documents nothing AMCP can send.
  }
  if (
    op.page !== contract.page ||
    op.method !== contract.method ||
    op.url !== microsoftOrigin + contract.path ||
    contract.fields.some(f => !request.includes(f)) ||
    ['FileUrl', 'FileUrlExpiryTimeUtc', 'LastModifiedTimeUtc'].some(f => !response.includes(f))
  )
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'AMCP Microsoft request differs from the REST request Microsoft Learn documents for this operation.',
      {
        action: contract.name,
        method: contract.method,
        url: microsoftOrigin + contract.path,
        documented: {method: op.method ?? null, url: op.url ?? null, page: op.page ?? null},
      },
    );
  return {method: op.method, url: op.url, page: op.page, source_sha256: envelope.document_sha256};
}

/** The one read of the lookup that reaches the advertising API: the current URL of the file, under the account. */
export function geoLocationsRequest(account: string, rest: JsonObject): CompiledRequest {
  return {
    gateway: microsoftGateway,
    action: contract.name,
    method: contract.method,
    path: contract.path,
    origin: microsoftOrigin,
    query: {},
    body: {Version: version, LanguageLocale: languageLocale, CompressionType: compressionType},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    accountId: account,
    evidence: 'INDEPENDENT_MICROSOFT_V13_EXTENSION',
    contractEvidence: {
      ...microsoftEvidence(contract.name, [...contract.fields]),
      rest,
      validation:
        'REST (JSON) method, URL and top-level fields match the optional Microsoft Learn pin; WSDL fields correspond.',
    },
    warnings: [],
  };
}

/** A location name to search for, or 1–100 location IDs to look up. Checked before anything is read. */
export function locationQuery(
  raw: unknown,
): {mode: 'search'; text: string; folded: string} | {mode: 'resolve'; ids: string[]} {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (/^[0-9][0-9,\s]*$/.test(value)) {
    const ids = value.split(/[\s,]+/).filter(Boolean);
    if (!ids.length || ids.length > limits.ids || !ids.every(numericId) || new Set(ids).size !== ids.length)
      throw new MirrorError(
        'INVALID_LOOKUP',
        'Enter a Microsoft location name, or 1–100 different numeric location IDs separated by commas or lines.',
        {field: 'query'},
      );
    return {mode: 'resolve', ids};
  }
  const folded = fold(value);
  if (
    [...value].length < 2 ||
    [...value].length > 80 ||
    folded.length < 2 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,'’()-]*$/u.test(value)
  )
    throw new MirrorError(
      'INVALID_LOOKUP',
      'Enter a Microsoft location name of 2–80 letters, or 1–100 numeric location IDs.',
      {field: 'query'},
    );
  return {mode: 'search', text: value, folded};
}
/** Case and accent folding for matching only; names are returned exactly as the file has them. */
function fold(value: string): string {
  const lower = /^[\x20-\x7e]*$/.test(value)
    ? value.toLowerCase()
    : value
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase();
  return lower.replace(/\s+/g, ' ').trim();
}

// ---------- the file ----------

/** The single member of a ZIP archive, as stored: one file, one disk, stored or deflated. Nothing touches the disk. */
function zipMember(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== 1 ||
    bytes.readUInt16LE(end + 10) !== 1
  )
    unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'zip_not_single_file');
  const central = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (central + size !== end || size < 46 || central + 46 > end || bytes.readUInt32LE(central) !== 0x02014b50)
    unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'zip_directory');
  const flags = bytes.readUInt16LE(central + 8),
    method = bytes.readUInt16LE(central + 10),
    checksum = bytes.readUInt32LE(central + 16),
    compressed = bytes.readUInt32LE(central + 20),
    expanded = bytes.readUInt32LE(central + 24),
    nameSize = bytes.readUInt16LE(central + 28),
    extra = bytes.readUInt16LE(central + 30),
    comment = bytes.readUInt16LE(central + 32),
    local = bytes.readUInt32LE(central + 42),
    name = bytes.toString('utf8', central + 46, central + 46 + nameSize);
  if (
    flags & ~0x80e ||
    ![0, 8].includes(method) ||
    expanded > limits.text_bytes ||
    compressed > limits.archive_bytes ||
    central + 46 + nameSize + extra + comment !== end ||
    !/^[^/\\\x00-\x1f]+\.(?:csv|txt)$/i.test(name) ||
    name.includes('..') ||
    local + 30 > central ||
    bytes.readUInt32LE(local) !== 0x04034b50 ||
    bytes.readUInt16LE(local + 8) !== method
  )
    unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'zip_member');
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (start + compressed > central) unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'zip_boundaries');
  return {method, checksum, expanded, data: bytes.subarray(start, start + compressed)};
}
/** The file's text bytes, inflated as they are read, within the text bound and checked against the archive's CRC. */
async function* inflated(bytes: Buffer): AsyncGenerator<Buffer> {
  let total = 0;
  const counted = (chunk: Buffer) => {
    total += chunk.length;
    if (total > limits.text_bytes)
      unreadable('Microsoft’s geographical locations file is larger than AMCP reads: 32 MiB compressed, 128 MiB of text or 1,000,000 rows.', 'text_bytes');
    return chunk;
  };
  const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b,
    member = gzip ? undefined : bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50 ? zipMember(bytes) : null;
  if (member === null) unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'not_an_archive');
  if (member?.method === 0) {
    yield counted(member.data);
    if (crc32(member.data) !== member.checksum || member.data.length !== member.expanded)
      unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'crc_or_size');
    return;
  }
  // GZip checks its own CRC and size as it ends; a ZIP member is checked against its directory entry below.
  const stream = gzip ? createGunzip() : createInflateRaw();
  stream.end(gzip ? bytes : member!.data);
  let checksum = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      counted(chunk);
      if (member) checksum = crc32(chunk, checksum);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof MirrorError) throw error;
    unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'inflate');
  } finally {
    stream.destroy();
  }
  if (member && (checksum !== member.checksum || total !== member.expanded))
    unreadable('Microsoft’s geographical locations archive is not a single-file ZIP or GZip archive, or it failed its size or CRC check.', 'crc_or_size');
}
const special = /[,\r\n"]/g;
/** Incremental RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks; CRLF or LF ends a row. */
class CsvRows {
  private row: string[] = [];
  private cell = '';
  // 0 at a field's start, 1 in an unquoted field, 2 in a quoted field, 3 just after a quote inside a quoted field.
  private state = 0;
  private skipLf = false;
  constructor(private emit: (cells: string[]) => void) {}
  private add(text: string) {
    this.cell += text;
    if (this.cell.length > limits.field_characters)
      unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'field_length');
  }
  private push() {
    this.row.push(this.cell);
    this.cell = '';
    this.state = 0;
    if (this.row.length > 64) unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'column_count');
  }
  private finish() {
    this.push();
    const row = this.row;
    this.row = [];
    this.emit(row);
  }
  feed(text: string) {
    let i = 0;
    while (i < text.length) {
      if (this.skipLf) {
        this.skipLf = false;
        if (text[i] === '\n') {
          i++;
          continue;
        }
      }
      if (this.state === 2) {
        // Quoted text up to the next quote is added at once; the quote either closes the field or escapes another.
        const next = text.indexOf('"', i);
        if (next < 0) {
          this.add(text.slice(i));
          return;
        }
        this.add(text.slice(i, next));
        i = next + 1;
        this.state = 3;
        continue;
      }
      const c = text[i]!;
      if (this.state === 3) {
        if (c === '"') {
          this.add('"');
          this.state = 2;
          i++;
          continue;
        }
        if (c !== ',' && c !== '\r' && c !== '\n')
          unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'text_after_quote');
      } else if (c === '"') {
        if (this.state === 1) unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'quote_in_field');
        this.state = 2;
        i++;
        continue;
      } else if (c !== ',' && c !== '\r' && c !== '\n') {
        // Unquoted text up to the next delimiter, quote or line break.
        special.lastIndex = i;
        const next = special.exec(text)?.index ?? text.length;
        this.add(text.slice(i, next));
        this.state = 1;
        i = next;
        continue;
      }
      if (c === ',') this.push();
      else {
        this.finish();
        this.skipLf = c === '\r';
      }
      i++;
    }
  }
  end() {
    if (this.state === 2) unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'unclosed_quote');
    if (this.row.length || this.cell || this.state !== 0) this.finish();
  }
}
type LocationRow = {id: string; name: string; type: string | null; status: string | null};
type FileShape = {columns: string[]; interpreted: JsonObject; rows: number};
const headers = {
  id: 'location id',
  name: 'bing display name',
  type: 'location type',
  status: 'status',
} as const;
/** A short native value (a type or status), kept literally; empty means unknown. */
function nativeValue(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (v.length > 64 || /[\u0000-\u001f\u007f]/.test(v))
    unreadable('Microsoft’s geographical locations file has a malformed or repeated location ID, name, type or status.', 'type_or_status');
  return v;
}
/**
 * One pass over the file. The first pass after a download also proves every location ID is numeric and listed once;
 * later passes over the same bytes skip that bookkeeping. `visit` sees every location row.
 */
async function scanFile(bytes: Buffer, visit: (row: LocationRow) => void, validate: boolean): Promise<FileShape> {
  let header: string[] | undefined,
    at = {id: -1, name: -1, type: -1, status: -1},
    rows = 0;
  const seen = validate ? new Set<string>() : undefined;
  const parser = new CsvRows(cells => {
    if (cells.every(c => !c.trim())) return;
    if (!header) {
      header = cells.map(c => c.trim());
      const folded = header.map(h => h.replace(/\s+/g, ' ').toLowerCase());
      if (new Set(folded).size !== folded.length)
        unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'repeated_column');
      at = {
        id: folded.indexOf(headers.id),
        name: folded.indexOf(headers.name),
        type: folded.indexOf(headers.type),
        status: folded.indexOf(headers.status),
      };
      // The guide documents these two columns; the others are read only when present.
      if (at.id < 0 || at.name < 0)
        unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'documented_columns');
      return;
    }
    if (cells.length !== header.length)
      unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'row_shape');
    if (++rows > limits.rows)
      unreadable('Microsoft’s geographical locations file is larger than AMCP reads: 32 MiB compressed, 128 MiB of text or 1,000,000 rows.', 'rows');
    const id = cells[at.id]!.trim(),
      name = cells[at.name]!.trim();
    if (!numericId(id) || !name || /[\u0000-\u001f\u007f]/.test(name))
      unreadable('Microsoft’s geographical locations file has a malformed or repeated location ID, name, type or status.', 'id_or_name');
    if (seen) {
      if (seen.has(id)) unreadable('Microsoft’s geographical locations file has a malformed or repeated location ID, name, type or status.', 'repeated_id');
      seen.add(id);
    }
    visit({
      id,
      name,
      type: at.type < 0 ? null : nativeValue(cells[at.type]),
      status: at.status < 0 ? null : nativeValue(cells[at.status]),
    });
  });
  let decoder: TextDecoder | undefined,
    head = Buffer.alloc(0);
  const decode = (chunk: Buffer, final = false) => {
    if (!decoder) {
      head = Buffer.concat([head, chunk]);
      if (head.length < 3 && !final) return;
      // UTF-8, with or without its byte order mark, or UTF-16 marked by one; the decoder drops the mark.
      const label =
        head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8';
      decoder = new TextDecoder(label, {fatal: true});
      chunk = head;
    }
    try {
      parser.feed(decoder.decode(chunk, {stream: !final}));
    } catch (error) {
      if (error instanceof MirrorError) throw error;
      unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'encoding');
    }
  };
  for await (const chunk of inflated(bytes)) decode(chunk);
  decode(Buffer.alloc(0), true);
  parser.end();
  if (!header) unreadable('Microsoft’s geographical locations file is not CSV text with the documented Location Id and Bing Display Name columns.', 'no_header');
  return {
    columns: header,
    interpreted: {
      location_id: header[at.id]!,
      display_name: header[at.name]!,
      location_type: at.type < 0 ? null : header[at.type]!,
      status: at.status < 0 ? null : header[at.status]!,
    },
    rows,
  };
}

/** The archive this deployment last read, one copy for every account (Microsoft's reference file). */
type Archive = {bytes: Buffer; last_modified: string | null; checked_at: number; read_at: number} & FileShape;
let archive: Archive | undefined, release: ReturnType<typeof setTimeout> | undefined;
/** Forgets the kept archive; the next lookup reads the file URL again. */
export function clearMicrosoftLocationFile() {
  archive = undefined;
  if (release) clearTimeout(release);
  release = undefined;
}
function keep(next: Archive) {
  archive = next;
  if (release) clearTimeout(release);
  // Kept for one more freshness period after its last check, then released.
  release = setTimeout(clearMicrosoftLocationFile, 2 * limits.fresh_ms);
  release.unref?.();
}
async function download(fileUrl: unknown, fetcher?: typeof fetch): Promise<Buffer> {
  let url: URL;
  try {
    url = reportUrl(fileUrl);
  } catch {
    unreadable('Microsoft did not return a public HTTPS address for its geographical locations file.', 'file_url');
  }
  const signal = AbortSignal.timeout(limits.download_ms);
  let response: Response;
  try {
    response = fetcher
      ? await fetcher(url, {redirect: 'error', signal, credentials: 'omit', headers: {Accept: 'application/zip'}})
      : await publicGet(url, signal);
  } catch (error) {
    // A host that resolves to a private address is not Microsoft's file; anything else may pass on a new attempt.
    if (error instanceof MirrorError && error.code === 'UNAPPROVED_REPORT_URL')
      unreadable('Microsoft did not return a public HTTPS address for its geographical locations file.', 'file_url');
    throw new MirrorError(
      'MICROSOFT_LOCATIONS_FILE_UNAVAILABLE',
      'Microsoft’s geographical locations file could not be downloaded. Search again in a moment.',
      {},
      502,
      true,
    );
  }
  if (response.status !== 200 || Number(response.headers.get('content-length')) > limits.archive_bytes) {
    await response.body?.cancel();
    throw new MirrorError(
      'MICROSOFT_LOCATIONS_FILE_UNAVAILABLE',
      'Microsoft’s geographical locations file could not be downloaded, or is larger than the 32 MiB AMCP reads.',
      {http_status: response.status},
      502,
      response.status >= 500,
    );
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limits.archive_bytes) {
          await reader.cancel();
          unreadable('Microsoft’s geographical locations file is larger than AMCP reads: 32 MiB compressed, 128 MiB of text or 1,000,000 rows.', 'archive_bytes');
        }
        chunks.push(value);
      }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (error instanceof MirrorError) throw error;
    throw new MirrorError(
      'MICROSOFT_LOCATIONS_FILE_UNAVAILABLE',
      'Microsoft’s geographical locations file could not be downloaded. Search again in a moment.',
      {},
      502,
      true,
    );
  } finally {
    reader?.releaseLock();
  }
  return Buffer.concat(chunks);
}

export interface MicrosoftLocationServices {
  store: Store;
  registry: Registry;
  transport: NativeTransport;
  credentials: CredentialProvider;
  /** A synthetic download for tests; production downloads pin public DNS (microsoft-report-download.ts). */
  fetcher?: typeof fetch;
}
/**
 * The archive to search: the kept one while it is fresh; otherwise the file URL is read again under the account, and
 * the file is downloaded only when Microsoft reports another modification time than the kept one's.
 */
async function currentArchive(
  services: MicrosoftLocationServices,
  actor: Actor,
  connection: Connection,
  account: string,
  rest: JsonObject,
  visit: (row: LocationRow) => void,
): Promise<{archive: Archive; provider_requests: number; downloaded: boolean; scanned: boolean}> {
  const now = Date.now();
  if (archive && now - archive.checked_at < limits.fresh_ms)
    return {archive, provider_requests: 0, downloaded: false, scanned: false};
  const {store, registry, transport, credentials, fetcher} = services,
    plan = geoLocationsRequest(account, rest),
    auth = (await credentials.get(connection)) as Credentials,
    authority = nativeAuthority(store, registry, actor, plan, connection, auth);
  const result = await transport.request(plan, authority(), auth, undefined, {beforeAttempt: authority});
  authority();
  const d = result.data;
  if (
    result.status !== 200 ||
    !obj(d) ||
    ['Errors', 'OperationErrors', 'PartialErrors'].some(
      key =>
        d[key] !== undefined && d[key] !== null && (!Array.isArray(d[key]) || d[key].some((e: unknown) => e !== null)),
    ) ||
    typeof d.FileUrl !== 'string' ||
    !d.FileUrl
  )
    throw new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Microsoft did not return a usable address for its geographical locations file.',
      {},
      502,
    );
  // The modification time is compared literally, so its format needs no interpretation.
  const modified =
      typeof d.LastModifiedTimeUtc === 'string' && /^[\w:.+\-/() ]{1,64}$/.test(d.LastModifiedTimeUtc)
        ? d.LastModifiedTimeUtc
        : null,
    expiry = typeof d.FileUrlExpiryTimeUtc === 'string' ? Date.parse(d.FileUrlExpiryTimeUtc) : NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now())
    throw new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Microsoft did not return a usable address for its geographical locations file.',
      {},
      502,
    );
  if (archive && modified && archive.last_modified === modified) {
    keep({...archive, checked_at: now});
    return {archive: archive!, provider_requests: 1, downloaded: false, scanned: false};
  }
  const bytes = await download(d.FileUrl, fetcher);
  // The person still holds this login and account after the download.
  authority();
  const shape = await scanFile(bytes, visit, true);
  keep({bytes, last_modified: modified, checked_at: now, read_at: now, ...shape});
  return {archive: archive!, provider_requests: 1, downloaded: true, scanned: true};
}
/** Whether a location may be added, from its status in the file (null when the file has no status column). */
function addable(row: LocationRow, statusColumn: boolean): {selectable: boolean; reason?: string} {
  if (!statusColumn) return {selectable: true, reason: 'status_not_in_file'};
  const status = (row.status ?? '').replace(/\s+/g, '').toLowerCase();
  if (status === 'active') return {selectable: true};
  if (status === 'pendingdeprecation') return {selectable: false, reason: 'pending_deprecation'};
  if (status === 'deprecated') return {selectable: false, reason: 'deprecated'};
  return {selectable: false, reason: 'status_unknown'};
}
/**
 * recipe_lookup with lookup_kind microsoft_location: up to 20 locations whose name contains the query (accents and case
 * ignored), or the locations of 1–100 IDs. Every input is checked first; then the person's Microsoft login and account,
 * then the optional pin, so an unavailable lookup sends nothing.
 */
export async function microsoftLocationLookup(
  services: MicrosoftLocationServices,
  actor: Actor,
  input: JsonObject,
  rest?: JsonObject,
): Promise<JsonObject> {
  const query = locationQuery(input.query),
    account = input.account_id;
  if (!numericId(account))
    throw new MirrorError('INVALID_LOOKUP', 'Choose the Microsoft advertising account first.', {field: 'account_id'});
  const {store} = services,
    connection = store.resolveConnection(actor, microsoftGateway, account, input.connection_id);
  microsoftCustomer(connection, account);
  const evidence = rest ?? geoLocationsRest(),
    found: {row: LocationRow; rank: number}[] = [],
    wanted = query.mode === 'resolve' ? new Set(query.ids) : undefined,
    resolved = new Map<string, LocationRow>();
  let matches = 0;
  const better = (a: {row: LocationRow; rank: number}, b: {row: LocationRow; rank: number}) =>
    a.rank - b.rank ||
    Number(b.row.status === 'Active') - Number(a.row.status === 'Active') ||
    a.row.name.length - b.row.name.length ||
    (BigInt(a.row.id) < BigInt(b.row.id) ? -1 : 1);
  const visit = (row: LocationRow) => {
    if (wanted) {
      if (wanted.has(row.id)) resolved.set(row.id, row);
      return;
    }
    const name = fold(row.name),
      at = name.indexOf((query as {folded: string}).folded);
    if (at < 0) return;
    matches++;
    const q = (query as {folded: string}).folded,
      entry = {
        row,
        rank: name === q ? 0 : at === 0 ? 1 : /[\s,(-]/.test(name[at - 1]!) ? 2 : 3,
      };
    if (found.length < limits.results || better(entry, found.at(-1)!) < 0) {
      found.push(entry);
      found.sort(better);
      if (found.length > limits.results) found.pop();
    }
  };
  const current = await currentArchive(services, actor, connection, account, evidence, visit);
  if (!current.scanned) await scanFile(current.archive.bytes, visit, false);
  // The person still holds this login and account when the answer is returned.
  store.assertActorActive(actor);
  store.resolveConnection(actor, microsoftGateway, account, connection.id);
  const file = current.archive,
    status = file.interpreted.status !== null,
    view = (row: LocationRow) => ({
      location_id: row.id,
      display_name: row.name,
      location_type: row.type,
      status: row.status,
      ...addable(row, status),
    });
  return {
    kind: 'microsoft_location',
    mode: query.mode,
    ...(query.mode === 'search'
      ? {query: query.text, match_count: matches, results: found.map(f => view(f.row))}
      : {
          location_ids: query.ids,
          results: query.ids.filter(id => resolved.has(id)).map(id => view(resolved.get(id)!)),
          missing_ids: query.ids.filter(id => !resolved.has(id)),
        }),
    file: {
      version,
      language_locale: languageLocale,
      last_modified: file.last_modified,
      read_at: new Date(file.read_at).toISOString(),
      checked_at: new Date(file.checked_at).toISOString(),
      rows: file.rows,
      columns: file.columns,
      interpreted: file.interpreted,
      kept_copy: !current.downloaded,
    },
    provider_requests: current.provider_requests,
    file_downloads: current.downloaded ? 1 : 0,
    provider_mutations: 0,
    meaning:
      'Location IDs and names from Microsoft’s geographical locations file, in English. A location criterion takes the location ID, and several IDs can share a name, so check the type. Add only locations the file lists as Active.',
  };
}
