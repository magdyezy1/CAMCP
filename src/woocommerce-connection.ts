import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {MirrorError} from './errors.js';
import {guardedLookup} from './media-link.js';
import {sha256, stable} from './security.js';
import {wooCommerceOrigin, wooCommerceRequest, type WooCommerceRequest} from './woocommerce-source.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

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

/** An explicit owner setup using an existing key: fixed native GETs, encrypted local storage, no provider changes. */
export async function connectWooCommerce(
  store: Store,
  actor: Actor,
  input: unknown,
  options: WooCommerceConnectionOptions = {},
) {
  store.assertActorActive(actor);
  if (actor.role !== 'admin' || actor.testAccount)
    throw new MirrorError('FORBIDDEN', 'Only a workspace administrator can connect a WooCommerce source.', {}, 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const data = input as JsonObject,
    fields = [
      'connection_id',
      'store_origin',
      'label',
      'consumer_key',
      'consumer_secret',
      'key_permission',
      'confirmed',
    ];
  if (
    Object.keys(data).length !== fields.length ||
    fields.some(key => !Object.hasOwn(data, key)) ||
    Object.keys(data).some(key => !fields.includes(key)) ||
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
  // This encryption check happens before admission or any credential-bearing request. Its probe is not persisted.
  try {
    store.sealValue(actor.tenantId, 'woocommerce-setup', connection.id, {fingerprint});
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'ENCRYPTION_REQUIRED')
      throw new MirrorError(error.code, error.message, {}, 503);
    throw error;
  }
  const request = options.request ?? wooCommerceRequest,
    monotonic = options.monotonic ?? (() => performance.now()),
    deadline = monotonic() + deadlineMs,
    controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), deadlineMs),
    signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    tenantLock = 'woocommerce-setup:' + sha256(actor.tenantId),
    owner = randomUUID();
  timeout.unref();
  let slot: string | undefined,
    locked = false,
    attempts = 0,
    bytes = 0;
  const active = () => {
    store.assertActorActive(actor);
    if (signal.aborted || monotonic() >= deadline) unavailable();
    if (
      locked &&
      [tenantLock, slot!].some(
        key =>
          !store.db
            .prepare('SELECT 1 FROM service_locks WHERE key=? AND owner=? AND expires_at>?')
            .get(key, owner, Date.now()),
      )
    )
      conflict();
  };
  const previous = () => {
    active();
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
    const current = JSON.parse(row.data);
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
  };
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    active();
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
      signal.addEventListener('abort', abort, {once: true});
    });
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
  const cancel = (body: ReadableStream | null | undefined) => body?.cancel().catch(() => {});
  const read = async (kind: 'currency' | 'products') => {
    active();
    if (++attempts > 3) incomplete();
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
    let response: Response | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      ended = false;
    try {
      const pending = request(url, {
        signal,
        lookup: guardedLookup(),
        headers: Object.freeze({
          Accept: 'application/json',
          'User-Agent': 'AMCP WooCommerce source setup',
          Authorization:
            'Basic ' + Buffer.from(credentials.consumerKey + ':' + credentials.consumerSecret).toString('base64'),
        }),
      });
      pending.then(
        value => {
          if (ended || signal.aborted) void cancel(value.body);
          else {
            try {
              active();
            } catch {
              void cancel(value.body);
            }
          }
        },
        () => {},
      );
      response = await wait(pending);
      active();
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== url.href) ||
        !/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
        (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') ||
        !response.body
      )
        unavailable();
      const declared = response.headers.get('content-length');
      if (
        declared !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(declared) ||
          !Number.isSafeInteger(Number(declared)) ||
          Number(declared) > maximumBytes - bytes)
      )
        incomplete();
      reader = response.body!.getReader();
      const chunks: Buffer[] = [];
      let length = 0,
        empty = 0;
      for (;;) {
        active();
        const chunk = await wait(reader.read());
        active();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) incomplete();
        if (!chunk.value.length && ++empty > 64) incomplete();
        length += chunk.value.length;
        bytes += chunk.value.length;
        if (bytes > maximumBytes) incomplete();
        chunks.push(Buffer.from(chunk.value));
      }
      if (declared !== null && Number(declared) !== length) incomplete();
      let result: JsonObject | JsonObject[];
      try {
        result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)), ((
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
      active();
      if (kind === 'currency') {
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
    } catch (error) {
      active();
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
      ended = true;
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else void cancel(response?.body);
    }
  };
  try {
    const replay = previous();
    if (replay) return replay;
    if (!store.acquireLock(tenantLock, owner, deadlineMs + 10000))
      throw new MirrorError(
        'WOOCOMMERCE_SETUP_BUSY',
        'Another WooCommerce setup is in progress. Refresh Commerce and try this request again shortly.',
        {},
        409,
        true,
      );
    for (let i = 0; i < 4; i++) {
      const key = 'woocommerce-setup-slot:' + i;
      if (store.acquireLock(key, owner, deadlineMs + 10000)) {
        slot = key;
        break;
      }
    }
    if (!slot)
      throw new MirrorError(
        'WOOCOMMERCE_SETUP_BUSY',
        'Another WooCommerce setup is in progress. Refresh Commerce and try this request again shortly.',
        {},
        429,
        true,
      );
    locked = true;
    const concurrentReplay = previous();
    if (concurrentReplay) return concurrentReplay;
    if (
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM connections WHERE tenant_id=? AND json_extract(data,'$.gateway')='commerce_native_action'",
          )
          .get(actor.tenantId) as {count: number}
      ).count >= maximumStores
    )
      throw new MirrorError(
        'WOOCOMMERCE_CONNECTION_LIMIT',
        'This workspace already has 50 WooCommerce connections. Remove an unused local connection before adding another.',
      );
    const currency = await read('currency'),
      reported = await read('products'),
      finalCurrency = await read('currency');
    if (currency !== finalCurrency) incomplete();
    active();
    const result = {
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
      network_requests: attempts,
      collected_bytes: bytes,
      replayed: false,
      meaning: wooCommerceConnectionMeaning,
    };
    store.transaction(() => {
      active();
      if (previous()) conflict();
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
        native_requests: attempts,
        provider_mutations: 0,
        writes_enabled: false,
      });
      active();
    });
    return result;
  } finally {
    controller.abort();
    clearTimeout(timeout);
    if (slot) store.releaseLock(slot, owner);
    store.releaseLock(tenantLock, owner);
  }
}
