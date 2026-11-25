import https from 'node:https';
import net from 'node:net';
import {Readable} from 'node:stream';
import type {OAuthClientInformationFull} from '@modelcontextprotocol/client';
import {InvalidClientError} from '@modelcontextprotocol/server-legacy/auth';
import {guardedLookup, type LinkRequest, type Resolver} from '../src/media-link.js';
import {MirrorError} from '../src/errors.js';

/**
 * OAuth Client ID Metadata Documents (CIMD; MCP-03 phase 2, review 2026-10-08). A client may identify itself with an
 * HTTPS URL instead of registering: AMCP fetches the JSON document at that URL and uses it as the registration. This
 * makes AMCP fetch a URL a client chose, so the fetch is guarded like the media-link import: HTTPS only, every address
 * the host resolves to must be public and is the address connected to, no redirect, a 5-second limit and at most
 * 10 KB. A document is cached for 5 minutes to 24 hours, and refusals for a minute. Nothing is stored in the database.
 *
 * r25-mf-auth item 1: reading a URL a stranger chose is bounded. Requests for one client_id share one read at a time, at
 * most `maxActive` documents are read at once across every client_id (a request that finds no free place is refused like
 * an unreadable document, and not remembered), and the token and revocation endpoints read a client's document only for
 * a client that presents a grant of its own (McpOAuth.authenticateClient); /authorize, where a client first appears, is
 * bounded by the first two and by its per-address limit.
 *
 * r25-mf-auth item 2: a saved good copy whose re-read gets no answer from the app's server (DNS, connection, timeout or an
 * HTTP 5xx: `Unreachable`) is kept and tried again in a minute, for at most a day beyond its lifetime; before, one failed
 * re-read replaced it with a refusal and signed every user of the app out for a minute. Anything the server did answer
 * and AMCP cannot use (a 3xx or 4xx, a body that is too large, not JSON or no longer acceptable) is a refusal and still
 * replaces the copy, as does a host that now resolves to a non-public address.
 */
export const clientMetadataMaxBytes = 10 * 1024;
const timeoutMs = 5000,
  minCacheMs = 5 * 60000,
  maxCacheMs = 24 * 3600000,
  defaultCacheMs = 3600000,
  refusalCacheMs = 60000,
  staleCopyMs = 24 * 3600000,
  /** Item 1: the most documents read at once across every client_id (each read lasts at most the 5-second limit). */
  maxActive = 8,
  cacheEntries = 500;

export interface ClientMetadataOptions {
  /** Exact host names whose documents are accepted (AMCP_MCP_CLIENT_METADATA_HOSTS); every public host when empty. */
  hosts?: string[];
  /** Tests replace the HTTPS transport or the DNS resolver; production uses the guarded defaults. */
  request?: LinkRequest;
  resolve?: Resolver;
  clock?: () => number;
}

const refuse = (reason: string) => new InvalidClientError('The client metadata document cannot be used: ' + reason);
/** The same refusal for a read that got no answer from the app's server: a saved good copy outlives it (item 2). */
class Unreachable extends InvalidClientError {}
const unreachable = (reason: string) => new Unreachable('The client metadata document cannot be used: ' + reason);
/** What is kept of one client_id: its document, or why it was refused. `staleUntil` ends a good copy's use as a stand-in. */
interface Entry {
  until: number;
  client?: OAuthClientInformationFull;
  error?: InvalidClientError;
  staleUntil?: number;
}

/**
 * What a client says about itself (its name, and the host it names), as it is kept and shown (review S4-9, the lead's
 * follow-up of 2026-11-22). The Owner confirmation puts the name inside a sentence, and Unicode format characters (a
 * right-to-left override, embeddings, isolates, marks, zero-width characters, a byte-order mark) or control characters
 * can reorder that sentence or disguise it. They are removed (categories Cf and Cc); `fallback` stands in when nothing
 * visible is left. A name is not verified by AMCP either way, which the consent screen says.
 */
export function clientDisplayText(value: unknown, fallback: string): string {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '');
  return text.trim() === '' ? fallback : text;
}

/** Whether a client_id names a metadata document: an HTTPS URL with a path. Registered client IDs are UUIDs. */
export function isClientMetadataUrl(id: string): boolean {
  return /^https:\/\/[^/]+\/./i.test(id);
}

/**
 * The URL a client_id names, if it is acceptable as a document location: HTTPS on port 443, a public host name (not an
 * address or a local name), a path without dot segments, and no user name, password, query or fragment.
 */
function documentUrl(id: string): URL {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    throw refuse('the client_id is not a URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.search ||
    url.hash ||
    url.href !== id
  )
    throw refuse('use an exact HTTPS URL without a port, user name, password, query or fragment as the client_id.');
  if (net.isIP(host) || !host.includes('.') || host.endsWith('.'))
    throw refuse('the client_id must use a public host name, not an address or a local name.');
  if (url.pathname === '/' || /(^|\/)\.\.?(\/|$)/.test(decodeURIComponent(url.pathname)))
    throw refuse('the client_id URL needs a path without dot segments.');
  return url;
}

/** One HTTPS GET for a JSON document on a fresh connection that connects only to the checked addresses. */
const metadataRequest: LinkRequest = (url, {signal, lookup}) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal,
        headers: {Accept: 'application/json', 'User-Agent': 'AMCP client metadata'},
      },
      response => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === 'string') headers.set(name, value);
        const status = response.statusCode ?? 502,
          empty = [204, 205, 304].includes(status);
        if (empty) response.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {status, headers}),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });

async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > clientMetadataMaxBytes) {
    await response.body?.cancel();
    throw refuse('the document is larger than 10 KB.');
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > clientMetadataMaxBytes) {
      await reader.cancel();
      throw refuse('the document is larger than 10 KB.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** How long a document may be reused: its Cache-Control max-age, kept within 5 minutes and 24 hours. */
function cacheLifetime(response: Response): number {
  const control = response.headers.get('cache-control') ?? '',
    age = /max-age=(\d+)/i.exec(control)?.[1];
  const ms = age === undefined ? defaultCacheMs : Number(age) * 1000;
  return Math.min(maxCacheMs, Math.max(minCacheMs, ms));
}

/** A redirect URI a client may use: exact HTTPS, or HTTP on a loopback address, without user info or fragment. */
export function acceptableRedirectUri(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const u = new URL(uri);
    return (
      !(u.username || u.password || u.hash) &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}

export class ClientMetadataDocuments {
  private cache = new Map<string, Entry>();
  /** The reads in progress, one per client_id, and how many there are (r25-mf-auth item 1). */
  private reading = new Map<string, Promise<OAuthClientInformationFull>>();
  private active = 0;
  private hosts?: Set<string>;
  constructor(
    private readonly defaultScope: string,
    private readonly options: ClientMetadataOptions = {},
  ) {
    if (options.hosts?.length) this.hosts = new Set(options.hosts.map(h => h.toLowerCase()));
  }
  private now() {
    return (this.options.clock ?? Date.now)();
  }
  private remember(id: string, entry: Entry) {
    this.cache.delete(id);
    this.cache.set(id, entry);
    while (this.cache.size > cacheEntries) this.cache.delete(this.cache.keys().next().value!);
  }
  /** The client a metadata document describes, as a registration of a public client (auth method none). */
  async client(id: string): Promise<OAuthClientInformationFull> {
    const cached = this.cache.get(id);
    if (cached && cached.until > this.now()) {
      if (cached.error) throw cached.error;
      return cached.client!;
    }
    // Item 1: requests for one client_id that arrive while its document is being read wait for that read, so a flood
    // for one id is one fetch, not one per request.
    let reading = this.reading.get(id);
    if (!reading) {
      reading = this.read(id, cached).finally(() => this.reading.delete(id));
      this.reading.set(id, reading);
    }
    return reading;
  }
  /** One read of the document at `id` (`cached`: what was kept of it), for every request waiting for it. */
  private async read(id: string, cached?: Entry): Promise<OAuthClientInformationFull> {
    // A good copy may stand in while it is within its day past its lifetime (item 2).
    const kept = cached?.client && (cached.staleUntil ?? 0) > this.now() ? cached : undefined;
    // Item 1: only so many documents are read at once, across every client_id, so many different ids cannot start
    // hundreds of fetches. No free place says nothing about the document, so it is not remembered: a kept copy stands in,
    // and otherwise the request is refused as an unreadable document is, in the same words.
    if (this.active >= maxActive) {
      if (kept) return kept.client!;
      throw refuse('it could not be fetched.');
    }
    this.active++;
    try {
      const {client, lifetime} = await this.fetch(id);
      const until = this.now() + lifetime;
      this.remember(id, {until, client, staleUntil: until + staleCopyMs});
      return client;
    } catch (e) {
      const error = e instanceof InvalidClientError ? e : refuse('it could not be fetched.');
      // Item 2: no answer is not a refusal. The good copy stays (its day of stand-in use does not slide) and the app's
      // server is asked again in a minute, not on every request.
      if (error instanceof Unreachable && kept) {
        this.remember(id, {...kept, until: this.now() + refusalCacheMs});
        return kept.client!;
      }
      this.remember(id, {until: this.now() + refusalCacheMs, error});
      throw error;
    } finally {
      this.active--;
    }
  }
  private async fetch(id: string): Promise<{client: OAuthClientInformationFull; lifetime: number}> {
    const url = documentUrl(id);
    if (this.hosts && !this.hosts.has(url.hostname.toLowerCase()))
      throw refuse('this AMCP deployment accepts client metadata documents only from the hosts its owner listed.');
    const request = this.options.request ?? metadataRequest;
    let response: Response;
    try {
      response = await request(url, {
        signal: AbortSignal.timeout(timeoutMs),
        lookup: guardedLookup(this.options.resolve),
      });
    } catch (e) {
      const cause = e instanceof MirrorError ? e : (e as {cause?: unknown}).cause;
      // A host that resolves to a non-public address is a refusal (it may be a rebinding); every other failure to get
      // an answer (DNS, connection, TLS, timeout) is not (item 2).
      if (cause instanceof MirrorError && cause.code === 'MEDIA_LINK_BLOCKED')
        throw refuse('its host does not resolve to a public internet address.');
      throw unreachable('it could not be fetched within 5 seconds.');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw refuse('the URL redirects; serve the document at the client_id URL itself.');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      // A 5xx is the server failing to answer; a 4xx (408 and 429 too) is its answer, so the document is refused.
      const reason = 'the URL returned HTTP ' + response.status + '.';
      throw response.status >= 500 ? unreachable(reason) : refuse(reason);
    }
    let text: string;
    try {
      text = await boundedText(response);
    } catch (e) {
      // The size limit is a refusal; a body that stops arriving (reset, timeout) is no answer.
      if (e instanceof InvalidClientError) throw e;
      throw unreachable('it could not be fetched within 5 seconds.');
    }
    let document: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
      document = parsed;
    } catch {
      throw refuse('it is not a JSON object.');
    }
    if (document.client_id !== id) throw refuse('its client_id does not equal the URL it was fetched from.');
    const redirects = document.redirect_uris;
    if (
      !Array.isArray(redirects) ||
      !redirects.length ||
      redirects.length > 10 ||
      !redirects.every(acceptableRedirectUri)
    )
      throw refuse('list 1 to 10 exact HTTPS or loopback HTTP redirect_uris.');
    if (document.token_endpoint_auth_method !== undefined && document.token_endpoint_auth_method !== 'none')
      throw refuse('AMCP accepts metadata documents only for public clients (token_endpoint_auth_method none).');
    if (document.client_secret !== undefined || document.client_secret_expires_at !== undefined)
      throw refuse('a metadata document must not contain a client secret.');
    if (
      (document.grant_types !== undefined &&
        (!Array.isArray(document.grant_types) || !document.grant_types.includes('authorization_code'))) ||
      (document.response_types !== undefined &&
        (!Array.isArray(document.response_types) || !document.response_types.includes('code')))
    )
      throw refuse('the client must use the authorization code grant.');
    if (document.scope !== undefined && typeof document.scope !== 'string') throw refuse('scope must be a string.');
    return {
      lifetime: cacheLifetime(response),
      client: {
        client_id: id,
        client_name: clientDisplayText(
          typeof document.client_name === 'string' ? document.client_name : url.hostname,
          url.hostname,
        ).slice(0, 120),
        redirect_uris: redirects as string[],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: (document.scope as string | undefined) ?? this.defaultScope,
      },
    };
  }
}
