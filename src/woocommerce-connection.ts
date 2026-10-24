import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {MirrorError} from './errors.js';
import {guardedLookup} from './media-link.js';
import {sha256, stable} from './security.js';
import {wooCommerceOrigin, wooCommerceRequest, type WooCommerceRequest} from './woocommerce-source.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';
import {provisionedRecord} from './connection-authority.js';
import {assertGatewayOffered} from './provider-offering.js';

const maximumBytes = 256 * 1024,
  maximumStores = 50,
  deadlineMs = 20000,
  uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalid = (): never => {
  throw new MirrorError(
    'INVALID_WOOCOMMERCE_CONNECTION',
    'Enter an exact public HTTPS store origin, a plain label, an existing Consumer Key and Consumer Secret, and confirm Read key permission.',
  );
};
const conflict = (): never => {
  throw new MirrorError(
    'WOOCOMMERCE_CONNECTION_CONFLICT',
    'This connection request no longer matches an unchanged read-only store. Refresh Commerce before trying a new request.',
    {},
    409,
  );
};
const unavailable = (): never => {
  throw new MirrorError(
    'WOOCOMMERCE_CONNECTION_UNAVAILABLE',
    'WooCommerce did not verify bounded product and currency reads. Check the HTTPS store origin, existing Read key, user permissions and REST API access.',
    {},
    502,
  );
};
const incomplete = (): never => {
  throw new MirrorError(
    'WOOCOMMERCE_CONNECTION_INCOMPLETE',
    'WooCommerce returned inconsistent, malformed or oversized setup evidence. No connection was saved.',
    {},
    502,
  );
};
export const wooCommerceConnectionMeaning =
  'Product access and unchanged store currency were read during setup. This verifies current read access only; the key permission is operator-recorded, not independently verified. Full inventory, future access and destination eligibility need separate inspection. AMCP stores the key encrypted and grants no store writes.';

export interface WooCommerceConnectionOptions {
  request?: WooCommerceRequest;
  signal?: AbortSignal;
  /** Internal test clock; never accepted from website input. */
  monotonic?: () => number;
}

/** A setup request that passed its checks: the store's origin, the connection it provisions and the key it stores. */
interface WooCommerceSetupRequest {
  readonly origin: URL;
  readonly connection: Connection;
  readonly credentials: {consumerKey: string; consumerSecret: string};
  /** The digest of the connection and the key, which a replay and the saved proof must match. */
  readonly fingerprint: string;
}
const setupFields = [
  'connection_id',
  'store_origin',
  'label',
  'consumer_key',
  'consumer_secret',
  'key_permission',
  'confirmed',
];

/**
 * Stage 1, admission: an active workspace administrator, a deployment that offers WooCommerce, and the exact setup
 * request (every field, nothing else), before anything is encrypted, locked or sent.
 */
function setupRequest(store: Store, actor: Actor, input: unknown): WooCommerceSetupRequest {
  store.assertActorActive(actor);
  // WooCommerce is parked (ARC-01, P9): only a deployment whose AMCP_PROVIDERS names it connects a store.
  assertGatewayOffered('commerce_native_action');
  if (actor.role !== 'admin' || actor.testAccount)
    throw new MirrorError('FORBIDDEN', 'Only a workspace administrator can connect a WooCommerce source.', {}, 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const data = input as JsonObject;
  if (
    Object.keys(data).length !== setupFields.length ||
    setupFields.some(key => !Object.hasOwn(data, key)) ||
    Object.keys(data).some(key => !setupFields.includes(key)) ||
    typeof data.connection_id !== 'string' ||
    !uuid.test(data.connection_id) ||
    typeof data.label !== 'string' ||
    !data.label.trim() ||
    data.label !== data.label.trim() ||
    data.label.length > 200 ||
    /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(data.label) ||
    typeof data.consumer_key !== 'string' ||
    !/^ck_[A-Za-z0-9]{1,200}$/.test(data.consumer_key) ||
    typeof data.consumer_secret !== 'string' ||
    !/^cs_[A-Za-z0-9]{1,200}$/.test(data.consumer_secret) ||
    data.key_permission !== 'read' ||
    data.confirmed !== true
  )
    invalid();
  const origin = wooCommerceOrigin(data.store_origin),
    connection: Connection = {
      id: data.connection_id,
      tenantId: actor.tenantId,
      gateway: 'commerce_native_action',
      accounts: ['wc_' + sha256(origin.origin)],
      label: data.label,
      enabled: true,
      baseUrl: origin.origin,
      apiVersion: 'wc/v3',
      scopes: ['read'],
      writeAccounts: [],
      defaultWriteAccess: false,
      isDefault: false,
    },
    credentials = {consumerKey: data.consumer_key, consumerSecret: data.consumer_secret},
    fingerprint = sha256(stable({connection, credentials}));
  return {origin, connection, credentials, fingerprint};
}

/** Stage 2: the encryption check, before admission or any credential-bearing request. Its probe is not persisted. */
function probeEncryption(store: Store, actor: Actor, {connection, fingerprint}: WooCommerceSetupRequest) {
  try {
    store.sealValue(actor.tenantId, 'woocommerce-setup', connection.id, {fingerprint});
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'ENCRYPTION_REQUIRED')
      throw new MirrorError(error.code, error.message, {}, 503);
    throw error;
  }
}

/** The fixed native read of one setup step: the store's currency setting, or one page of one published product. */
function setupReadUrl(origin: URL, kind: 'currency' | 'products'): URL {
  const url = new URL(
    kind === 'currency' ? '/wp-json/wc/v3/settings/general/woocommerce_currency' : '/wp-json/wc/v3/products',
    origin,
  );
  url.searchParams.set('_fields', kind === 'currency' ? 'id,value' : 'id,status');
  if (kind === 'products')
    for (const [key, value] of Object.entries({
      context: 'view',
      status: 'publish',
      order: 'asc',
      orderby: 'id',
      per_page: '1',
      page: '1',
    }))
      url.searchParams.set(key, value);
  return url;
}

/** A setup read's answer must be the read's own JSON, uncompressed and not redirected. */
function checkSetupResponse(response: Response, url: URL) {
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.url && response.url !== url.href) ||
    !/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
    (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') ||
    !response.body
  )
    unavailable();
}

/** The JSON of a setup read; integers beyond the safe range keep their source text. */
function parseSetupBody(body: Buffer): JsonObject | JsonObject[] {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body), ((
      _key: string,
      value: unknown,
      context?: {source: string},
    ) =>
      typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
        ? (context?.source ?? String(value))
        : value) as any);
  } catch {
    return incomplete();
  }
}

/** The store's currency: the setting's own record, a three-letter code. */
function setupCurrency(result: JsonObject | JsonObject[]): string {
  if (
    !result ||
    Array.isArray(result) ||
    result.id !== 'woocommerce_currency' ||
    typeof result.value !== 'string' ||
    !/^[A-Z]{3}$/.test(result.value)
  )
    incomplete();
  return (result as JsonObject).value as string;
}

/** The published products WooCommerce reports: its totals agree, and the one page holds one published product. */
function publishedProducts(response: Response, result: JsonObject | JsonObject[]): number {
  const totalHeader = response.headers.get('x-wp-total'),
    pagesHeader = response.headers.get('x-wp-totalpages');
  if (
    totalHeader === null ||
    pagesHeader === null ||
    !/^(0|[1-9][0-9]*)$/.test(totalHeader) ||
    !/^(0|[1-9][0-9]*)$/.test(pagesHeader)
  )
    incomplete();
  const total = Number(totalHeader),
    pages = Number(pagesHeader);
  if (
    !Number.isSafeInteger(total) ||
    pages !== total ||
    !Array.isArray(result) ||
    result.length !== Math.min(1, total) ||
    result.some(
      row =>
        !row ||
        Array.isArray(row) ||
        typeof row !== 'object' ||
        row.status !== 'publish' ||
        !/^[1-9][0-9]{0,19}$/.test(
          typeof row.id === 'number' && Number.isSafeInteger(row.id)
            ? String(row.id)
            : typeof row.id === 'string'
              ? row.id
              : '',
        ),
    )
  )
    incomplete();
  return total;
}

const cancel = (body: ReadableStream | null | undefined) => body?.cancel().catch(() => {});

/** What one setup read holds until it ends: its answer, its body reader, and whether it has ended. */
interface SetupRead {
  ended: boolean;
  response?: Response;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

/**
 * One setup attempt (stages 3 to 5): its deadline and abort signal, its tenant lock and setup slot, the replay of an
 * unchanged earlier setup, the bounded reads and the saved connection. Every step checks first that the actor is still
 * active, the attempt is within its deadline and its locks are still its own.
 */
class WooCommerceSetup {
  private readonly request: WooCommerceRequest;
  private readonly monotonic: () => number;
  private readonly deadline: number;
  private readonly controller: AbortController;
  private readonly timeout: NodeJS.Timeout;
  private readonly signal: AbortSignal;
  private readonly tenantLock: string;
  private readonly owner: string;
  private slot: string | undefined;
  private locked = false;
  /** The native requests and collected bytes of this attempt, across its reads. */
  attempts = 0;
  bytes = 0;
  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    private readonly setup: WooCommerceSetupRequest,
    options: WooCommerceConnectionOptions,
  ) {
    this.request = options.request ?? wooCommerceRequest;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.deadline = this.monotonic() + deadlineMs;
    this.controller = new AbortController();
    const controller = this.controller;
    this.timeout = setTimeout(() => controller.abort(), deadlineMs);
    this.signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    this.tenantLock = 'woocommerce-setup:' + sha256(actor.tenantId);
    this.owner = randomUUID();
    this.timeout.unref();
  }
  /** The actor is active, the attempt within its deadline, and once locked its locks are still its own. */
  active() {
    this.store.assertActorActive(this.actor);
    if (this.signal.aborted || this.monotonic() >= this.deadline) unavailable();
    if (
      this.locked &&
      [this.tenantLock, this.slot!].some(
        key =>
          !this.store.db
            .prepare('SELECT 1 FROM service_locks WHERE key=? AND owner=? AND expires_at>?')
            .get(key, this.owner, Date.now()),
      )
    )
      conflict();
  }
  /**
   * The result of an earlier, unchanged setup of this connection (a replay without any request), nothing when there is
   * none, or a refusal when the connection was removed or changed since.
   */
  previous() {
    this.active();
    const {store, actor} = this,
      {connection, fingerprint} = this.setup;
    if (
      store.db
        .prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='connection_disconnection' AND id=?")
        .get(actor.tenantId, sha256(stable([connection.gateway, connection.id])))
    )
      conflict();
    const row = store.db
      .prepare('SELECT data FROM connections WHERE tenant_id=? AND id=?')
      .get(actor.tenantId, connection.id) as {data: string} | undefined;
    if (!row) return;
    // The store adds its own login revision and id (CON-01); compare only what this setup provisioned.
    const current = provisionedRecord(JSON.parse(row.data));
    let proof: JsonObject;
    try {
      const document = store.document(actor.tenantId, 'website_connection', connection.id);
      if (typeof document.woocommerce_setup?.secret !== 'string') return conflict();
      proof = store.openValue(actor.tenantId, 'woocommerce-setup', connection.id, document.woocommerce_setup.secret);
    } catch {
      return conflict();
    }
    if (
      stable(current) !== stable(connection) ||
      sha256(stable({connection: current, credentials: store.credentials(actor.tenantId, connection.id)})) !==
        fingerprint ||
      proof.fingerprint !== fingerprint ||
      !proof.result
    )
      conflict();
    return {...proof.result, replayed: true, network_requests: 0, collected_bytes: 0};
  }
  /** Waits for a pending step, which the attempt's abort ends with WOOCOMMERCE_CONNECTION_UNAVAILABLE. */
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.active();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          new MirrorError(
            'WOOCOMMERCE_CONNECTION_UNAVAILABLE',
            'WooCommerce did not verify bounded product and currency reads. Check the HTTPS store origin, existing Read key, user permissions and REST API access.',
            {},
            502,
          ),
        );
      this.signal.addEventListener('abort', abort, {once: true});
    });
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      this.signal.removeEventListener('abort', abort);
    }
  }
  /** Stage 3: the tenant's setup lock and one of four setup slots, held until the attempt releases them. */
  admit() {
    if (!this.store.acquireLock(this.tenantLock, this.owner, deadlineMs + 10000))
      throw new MirrorError(
        'WOOCOMMERCE_SETUP_BUSY',
        'Another WooCommerce setup is in progress. Refresh Commerce and try this request again shortly.',
        {},
        409,
        true,
      );
    for (let i = 0; i < 4; i++) {
      const key = 'woocommerce-setup-slot:' + i;
      if (this.store.acquireLock(key, this.owner, deadlineMs + 10000)) {
        this.slot = key;
        break;
      }
    }
    if (!this.slot)
      throw new MirrorError(
        'WOOCOMMERCE_SETUP_BUSY',
        'Another WooCommerce setup is in progress. Refresh Commerce and try this request again shortly.',
        {},
        429,
        true,
      );
    this.locked = true;
  }
  /** A workspace keeps at most 50 WooCommerce connections. */
  assertCapacity() {
    if (
      (
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM connections WHERE tenant_id=? AND json_extract(data,'$.gateway')='commerce_native_action'",
          )
          .get(this.actor.tenantId) as {count: number}
      ).count >= maximumStores
    )
      throw new MirrorError(
        'WOOCOMMERCE_CONNECTION_LIMIT',
        'This workspace already has 50 WooCommerce connections. Remove an unused local connection before adding another.',
      );
  }
  /** Stage 4, one bounded read: at most three in an attempt, each fixed, its answer checked and read within bounds. */
  async read(kind: 'currency' | 'products'): Promise<string | number> {
    this.active();
    if (++this.attempts > 3) incomplete();
    const url = setupReadUrl(this.setup.origin, kind),
      read: SetupRead = {ended: false};
    try {
      const response = (read.response = await this.send(url, read));
      this.active();
      checkSetupResponse(response, url);
      const declared = response.headers.get('content-length');
      if (
        declared !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(declared) ||
          !Number.isSafeInteger(Number(declared)) ||
          Number(declared) > maximumBytes - this.bytes)
      )
        incomplete();
      read.reader = response.body!.getReader();
      const result = parseSetupBody(await this.body(read.reader, declared));
      this.active();
      return kind === 'currency' ? setupCurrency(result) : publishedProducts(response, result);
    } catch (error) {
      this.active();
      if (
        error instanceof MirrorError &&
        [
          'WOOCOMMERCE_CONNECTION_INCOMPLETE',
          'WOOCOMMERCE_CONNECTION_UNAVAILABLE',
          'WOOCOMMERCE_CONNECTION_CONFLICT',
        ].includes(error.code)
      )
        throw error;
      return unavailable();
    } finally {
      read.ended = true;
      if (read.reader) {
        void read.reader.cancel().catch(() => {});
        read.reader.releaseLock();
      } else void cancel(read.response?.body);
    }
  }
  /** The read's one request, with the key; an answer that arrives after the read ended, or the attempt, is cancelled. */
  private send(url: URL, read: SetupRead): Promise<Response> {
    const {consumerKey, consumerSecret} = this.setup.credentials;
    const pending = this.request(url, {
      signal: this.signal,
      lookup: guardedLookup(),
      headers: Object.freeze({
        Accept: 'application/json',
        'User-Agent': 'AMCP WooCommerce source setup',
        Authorization: 'Basic ' + Buffer.from(consumerKey + ':' + consumerSecret).toString('base64'),
      }),
    });
    pending.then(
      value => {
        if (read.ended || this.signal.aborted) void cancel(value.body);
        else {
          try {
            this.active();
          } catch {
            void cancel(value.body);
          }
        }
      },
      () => {},
    );
    return this.wait(pending);
  }
  /** The answer's bytes, within the attempt's byte bound and the length it declared. */
  private async body(reader: ReadableStreamDefaultReader<Uint8Array>, declared: string | null): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0,
      empty = 0;
    for (;;) {
      this.active();
      const chunk = await this.wait(reader.read());
      this.active();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) incomplete();
      if (!chunk.value.length && ++empty > 64) incomplete();
      length += chunk.value.length;
      this.bytes += chunk.value.length;
      if (this.bytes > maximumBytes) incomplete();
      chunks.push(Buffer.from(chunk.value));
    }
    if (declared !== null && Number(declared) !== length) incomplete();
    return Buffer.concat(chunks);
  }
  /** What the setup verified, as the website shows it and the saved proof keeps it. */
  result(currency: string, reported: number) {
    const {connection, origin} = this.setup;
    return {
      record_kind: 'woocommerce_connection',
      connection_id: connection.id,
      account_id: connection.accounts[0],
      account_id_kind: 'amcp_origin_binding',
      label: connection.label,
      store_origin: origin.origin,
      key_permission: 'read',
      key_permission_evidence: 'operator_recorded',
      read_access_verified: true,
      verified_at: new Date().toISOString(),
      native_currency: currency,
      reported_published_products: reported,
      full_inventory: false,
      writes_enabled: false,
      credentials_disclosed: false,
      provider_mutations: 0,
      network_requests: this.attempts,
      collected_bytes: this.bytes,
      replayed: false,
      meaning: wooCommerceConnectionMeaning,
    };
  }
  /** Stage 5: the connection, its encrypted key and the sealed proof of this setup, saved together and audited. */
  persist(result: JsonObject) {
    const {store, actor} = this,
      {connection, credentials, fingerprint} = this.setup;
    store.transaction(() => {
      this.active();
      if (this.previous()) conflict();
      store.putConnection(actor, connection, credentials);
      store.putDocument(actor.tenantId, 'website_connection', connection.id, {
        woocommerce_setup: {
          secret: store.sealValue(actor.tenantId, 'woocommerce-setup', connection.id, {fingerprint, result}),
        },
      });
      store.appendAudit(actor.tenantId, randomUUID(), {
        event: 'website_woocommerce_connected',
        connection_id: connection.id,
        read_verified: true,
        native_requests: this.attempts,
        provider_mutations: 0,
        writes_enabled: false,
      });
      this.active();
    });
  }
  /** Ends the attempt: its abort, its timer and its locks. */
  release() {
    this.controller.abort();
    clearTimeout(this.timeout);
    if (this.slot) this.store.releaseLock(this.slot, this.owner);
    this.store.releaseLock(this.tenantLock, this.owner);
  }
}

/**
 * An explicit owner setup using an existing key: fixed native GETs, encrypted local storage, no provider changes
 * (ARC-04: staged steps). Admission and the request's checks, the encryption probe, then one attempt: a replay of an
 * unchanged earlier setup, the locks, the capacity check, the three bounded reads (currency, products, currency again,
 * which must agree) and the saved connection.
 */
export async function connectWooCommerce(
  store: Store,
  actor: Actor,
  input: unknown,
  options: WooCommerceConnectionOptions = {},
) {
  const setup = setupRequest(store, actor, input);
  probeEncryption(store, actor, setup);
  const attempt = new WooCommerceSetup(store, actor, setup, options);
  try {
    const replay = attempt.previous();
    if (replay) return replay;
    attempt.admit();
    const concurrentReplay = attempt.previous();
    if (concurrentReplay) return concurrentReplay;
    attempt.assertCapacity();
    const currency = (await attempt.read('currency')) as string,
      reported = (await attempt.read('products')) as number,
      finalCurrency = await attempt.read('currency');
    if (currency !== finalCurrency) incomplete();
    attempt.active();
    const result = attempt.result(currency, reported);
    attempt.persist(result);
    return result;
  } finally {
    attempt.release();
  }
}
