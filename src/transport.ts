import {createHash, createHmac, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {MirrorError, providerHttpErrorCode} from './errors.js';
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {redact, scopeKey, sha256} from './security.js';
import {linkedinQuery} from './linkedin-restli.js';
import {googleJson, validateGoogleRequest} from './google-contracts.js';
import {enforceWireContract, recordWireViolation, wireContractCheck, wireContractMode} from './wire-contracts.js';
import {googleGenerationKind, googleGenerationResult, validateGoogleGeneration} from './google-generation.js';
import {
  dv360TargetingSearchRoute,
  validateDV360TargetingSearch,
  dv360TargetingSearchResult,
} from './dv360-targeting-search.js';
import type {Store} from './store.js';
import {
  microsoftGateway,
  microsoftOrigin,
  microsoftCustomerOrigin,
  microsoftReportOrigin,
  microsoftCustomer,
} from './microsoft-native.js';
import {criteoRoute} from './criteo-version.js';
import {linkedinDefaultVersion} from './linkedin-version.js';
import {
  classifyProviderError,
  providerErrorTaxonomyEnabled,
  providerReference,
  providerRequestId,
  type ProviderErrorClass,
} from './provider-error-taxonomy.js';
import {collectionRequestTimeout, collectionResponseBytes, collectionCheckpoint} from './report-collection-budget.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {currentQuotaPurpose, issuerKey, requestOperations, type IssuerPermit} from './provider-quota.js';
import {meterNativeRequest} from './native-request-meter.js';
/**
 * Whether a mutation request (or an upload chunk) left AMCP while a tracked operation ran (WRT-04). The marker is set
 * synchronously, immediately before the fetch, so a request that was sent is never recorded as unsent; a refusal raised
 * before it (pause, expiry, rate limit, open circuit, missing credentials) provably sent nothing.
 */
const dispatches = new AsyncLocalStorage<{sent: boolean}>();
export function trackDispatch<T>(record: {sent: boolean}, run: () => Promise<T>): Promise<T> {
  return dispatches.run(record, run);
}
function markDispatched() {
  const record = dispatches.getStore();
  if (record) record.sent = true;
}
export const vendorOrigins: Record<string, string> = {
  google_sheets_native_action: 'https://www.googleapis.com',
  google_drive_native_action: 'https://www.googleapis.com',
  meta_native_action: 'https://graph.facebook.com',
  tiktok_native_action: 'https://business-api.tiktok.com',
  snapchat_native_action: 'https://adsapi.snapchat.com',
  google_ads_native_action: 'https://googleads.googleapis.com',
  linkedin_native_action: 'https://api.linkedin.com',
  x_ads_native_action: 'https://ads-api.x.com',
  dv360_native_action: 'https://displayvideo.googleapis.com',
  amazon_native_action: 'https://advertising-api.amazon.com',
  apple_ads_native_action: 'https://api.searchads.apple.com',
  reddit_native_action: 'https://ads-api.reddit.com',
  criteo_native_action: 'https://api.criteo.com',
  ga4_native_action: 'https://analyticsdata.googleapis.com',
  gtm_native_action: 'https://tagmanager.googleapis.com',
  google_business_native_action: 'https://mybusinessbusinessinformation.googleapis.com',
  google_search_console_native_action: 'https://searchconsole.googleapis.com',
  adjust_native_action: 'https://automate.adjust.com',
};
const additionalOrigins: Record<string, string[]> = {
  google_sheets_native_action: ['https://sheets.googleapis.com'],
  amazon_native_action: ['https://advertising-api-eu.amazon.com', 'https://advertising-api-fe.amazon.com'],
  apple_ads_native_action: ['https://api.ads.apple.com'],
  ga4_native_action: ['https://analyticsadmin.googleapis.com'],
  google_business_native_action: [
    'https://mybusinessaccountmanagement.googleapis.com',
    'https://mybusiness.googleapis.com',
    'https://businessprofileperformance.googleapis.com',
    'https://mybusinessverifications.googleapis.com',
    'https://mybusinessnotifications.googleapis.com',
    'https://mybusinesslodging.googleapis.com',
  ],
  x_ads_native_action: ['https://upload.twitter.com', 'https://api.x.com', 'https://upload.x.com'],
  google_search_console_native_action: ['https://www.googleapis.com'],
  // Google's Data Manager API (Customer Match and offline conversions), approved by the owner on 2026-09-30.
  google_ads_native_action: ['https://datamanager.googleapis.com'],
  adjust_native_action: ['https://api.adjust.com', 'https://dash.adjust.com'],
};
export function buildUrl(
  request: CompiledRequest,
  connection: Connection,
  environment: 'production' | 'sandbox' = 'production',
): URL {
  if (/[?#\r\n\\]/.test(request.path) || !request.path.startsWith('/') || request.path.startsWith('//'))
    throw new MirrorError(
      'INVALID_PATH',
      'Request paths cannot contain a query, fragment or authority. Supply query parameters separately.',
    );
  // URL parsing resolves dot segments (also percent-encoded ones), so /act_1/%2e%2e/2 would reach /2 while scope checks
  // saw act_1. The compilers already refuse them; this keeps the transport safe for any hand-built path.
  if (request.path.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment)))
    throw new MirrorError('INVALID_PATH', 'Request paths cannot contain dot segments.');
  const base =
    request.origin ??
    connection.baseUrl ??
    (request.gateway === microsoftGateway ? microsoftOrigin : vendorOrigins[request.gateway]);
  if (!base)
    throw new MirrorError(
      'CONNECTOR_CONFIGURATION_REQUIRED',
      'Configure an approved upstream origin for this gateway.',
    );
  const origin = new URL(base);
  const allowed = [
    vendorOrigins[request.gateway],
    ...(additionalOrigins[request.gateway] ?? []),
    ...(request.gateway === microsoftGateway ? [microsoftOrigin, microsoftCustomerOrigin, microsoftReportOrigin] : []),
    ...(request.gateway === 'google_business_native_action' ? ['https://mybusinessplaceactions.googleapis.com'] : []),
  ];
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !allowed.includes(origin.origin)
  )
    throw new MirrorError('UNAPPROVED_UPSTREAM', 'Upstream origin is not allowed for this gateway.', {}, 403);
  let path = request.path;
  if (request.gateway === 'tiktok_native_action' && !path.startsWith('/open_api/')) path = '/open_api' + path;
  let target = origin;
  if (environment === 'sandbox') {
    const sandbox =
      request.gateway === 'x_ads_native_action' && origin.origin === 'https://ads-api.x.com'
        ? 'https://ads-api-sandbox.x.com'
        : request.gateway === microsoftGateway &&
            [microsoftOrigin, microsoftCustomerOrigin, microsoftReportOrigin].includes(origin.origin)
          ? origin.origin.replace('.api.', '.api.sandbox.')
          : undefined;
    if (!sandbox)
      throw new MirrorError(
        'SANDBOX_ROUTE_UNQUALIFIED',
        'This endpoint has no qualified isolated sandbox origin. External media/social endpoints and production fallback are forbidden.',
      );
    target = new URL(sandbox);
  }
  const url = new URL(path, target);
  if (url.origin !== target.origin)
    throw new MirrorError('UNAPPROVED_UPSTREAM', 'Request escaped the platform origin.', {}, 403);
  if (request.gateway === 'linkedin_native_action') url.search = linkedinQuery(request.query);
  else
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && request.queryArrayEncoding === 'repeat') {
        for (const item of value) url.searchParams.append(key, String(item));
      } else url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  return url;
}
const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function oauth1(
  method: string,
  url: URL,
  credentials: Credentials,
  bodyParams?: URLSearchParams,
  nonce: string = randomUUID(),
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
): string {
  if (!credentials.consumerKey || !credentials.consumerSecret || !credentials.accessToken || !credentials.tokenSecret)
    throw new MirrorError('OAUTH1_CREDENTIALS_REQUIRED', 'X Ads requires consumer and user OAuth 1.0a credentials.');
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_token: credentials.accessToken,
    oauth_nonce: nonce,
    oauth_timestamp: timestamp,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  };
  const entries = [...url.searchParams.entries(), ...(bodyParams?.entries() ?? []), ...Object.entries(oauth)]
    .map(([k, v]) => [pct(k), pct(v)] as [string, string])
    .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0));
  const params = entries.map(([k, v]) => k + '=' + v).join('&');
  const baseUrl = url.origin + url.pathname;
  const signature = createHmac('sha1', pct(credentials.consumerSecret) + '&' + pct(credentials.tokenSecret))
    .update(method.toUpperCase() + '&' + pct(baseUrl) + '&' + pct(params))
    .digest('base64');
  return (
    'OAuth ' +
    Object.entries({...oauth, oauth_signature: signature})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => pct(k) + '="' + pct(v) + '"')
      .join(', ')
  );
}
const camelKeys = googleJson;
export interface TransportResult {
  data: unknown;
  status: number;
  headers: Record<string, string>;
  bodyIntegrity?: {bytes: number; md5: string};
  /** `data` with each unsafe integer literal as its exact decimal text; only when the body held one (PRV-05). */
  exactData?: unknown;
}
export interface BinaryUpload {
  field: string;
  bytes: Buffer;
  filename: string;
  mime: string;
  format?: 'related' | 'fields';
}
/**
 * RPT-01 optional increment, off unless AMCP_REPORT_LOSSLESS_NUMBERS=true: read-only report data responses keep each
 * fractional JSON number as its exact source text, so nine-place rounding provenance (provider-decimal.ts) is exact even
 * where the shortest double text differs. Safe integers (status codes, page counters) stay numbers; account lookups
 * and writes are unaffected.
 */
export function losslessReportNumbers(plan: CompiledRequest, env: Record<string, string | undefined> = process.env) {
  if (env.AMCP_REPORT_LOSSLESS_NUMBERS !== 'true' || !plan.readOnly || plan.method === 'HEAD') return false;
  return (
    (plan.gateway === 'google_ads_native_action' && /\/googleAds:search$/.test(plan.path)) ||
    (plan.gateway === 'meta_native_action' && /\/insights$/.test(plan.path)) ||
    (plan.gateway === 'tiktok_native_action' && /\/report\/integrated\/get\/$/.test(plan.path)) ||
    (plan.gateway === 'snapchat_native_action' && /\/stats$/.test(plan.path)) ||
    (plan.gateway === 'linkedin_native_action' && plan.path === '/rest/adAnalytics')
  );
}
/**
 * Lossless unsafe integers on every gateway (PRV-05): JSON.parse rounds an integer beyond 2^53, so a 64-bit ID such as
 * 1800000000000000001 would be shown as 1800000000000000000, and a caller could then target another entity with it.
 * `data` keeps JSON's numbers, so every family, evidence and contract check sees what it saw before (a check that
 * refuses an unsafe numeric identity still refuses it). When the body holds an unsafe integer literal, the result also
 * carries `exactData`: the same response with each such literal as its exact decimal text, which a native read returns
 * to its caller (src/service.ts). Only a body with a 16-digit number token takes the second, source-aware parse.
 */
const unsafeIntegerToken = /[:[,]\s*-?\d{16,}\s*[,}\]]/;
export function exactIntegerJson(text: string): unknown {
  if (!unsafeIntegerToken.test(text)) return undefined;
  let found = false;
  const value = JSON.parse(text, ((_key: string, v: unknown, context?: {source: string}) => {
    if (
      typeof v === 'number' &&
      Number.isInteger(v) &&
      !Number.isSafeInteger(v) &&
      context &&
      /^-?\d+$/.test(context.source)
    ) {
      found = true;
      return context.source;
    }
    return v;
  }) as any);
  return found ? value : undefined;
}
export function providerRetryDelay(response: Response, gateway: string, now = Date.now()): number | undefined {
  const header = response.headers.get('retry-after');
  let delay: number | undefined;
  if (header !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN,
      date = Date.parse(header);
    if (Number.isFinite(seconds)) delay = seconds * 1000;
    else if (Number.isFinite(date)) delay = Math.max(0, date - now);
  }
  if (gateway === 'x_ads_native_action' && response.status === 429) {
    const reset = response.headers.get('x-account-rate-limit-reset') ?? response.headers.get('x-rate-limit-reset'),
      seconds = Number(reset);
    if (reset && Number.isFinite(seconds) && seconds > 0) {
      const server = Date.parse(response.headers.get('date') ?? ''),
        remaining = seconds * 1000 - (Number.isFinite(server) ? server : now);
      delay = Math.max(delay ?? 0, remaining);
    }
  }
  if (delay === undefined && response.status === 429) delay = 30000;
  return delay === undefined ? undefined : Math.max(1000, Math.min(86400000, Math.ceil(delay)));
}
export class NativeTransport {
  coordination?: Store;
  /** One provider 429 against the issuer's daily counters (OPS-08); a counting failure never changes the outcome. */
  private issuerRateLimit(permit: IssuerPermit | undefined) {
    if (!permit) return;
    try {
      this.coordination?.providerIssuerRateLimit?.(permit);
    } catch {}
  }
  private circuits = new Map<
    string,
    {failures: number; until: number; at: number; probing?: boolean; code?: string; status?: number}
  >();
  private budgets = new Map<string, {tokens: number; at: number}>();
  private cooldowns = new Map<string, number>();
  readonly metrics = {
    requests: 0,
    retries: 0,
    errors: 0,
    rateLimits: 0,
    totalLatencyMs: 0,
    /** Violations of reviewed writes: the enforcement gate (docs/WRITE-OPERATIONS.md) counts these. */
    wireContractViolations: 0,
    /** Violations of reads, which are never enforced (a vendor may document aliases its schema does not list). */
    wireContractReadViolations: 0,
    /** Checks that failed in the validator itself; the request still went out unless it was an enforced write. */
    wireContractCheckFailures: 0,
  };
  diagnostics() {
    return {
      ...this.metrics,
      budget_entries: this.budgets.size,
      circuit_entries: this.circuits.size,
      scope: 'Current process only; shared rate enforcement uses SQLite.',
    };
  }
  private prune() {
    const now = performance.now();
    for (const [key, b] of this.budgets) if (now - b.at > 60000) this.budgets.delete(key);
    for (const [key, c] of this.circuits)
      if (!c.probing && now - c.at > 60000 && c.until <= now) this.circuits.delete(key);
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    if (this.budgets.size >= 4096 || this.circuits.size >= 4096 || this.cooldowns.size >= 4096)
      throw new MirrorError(
        'PROVIDER_COORDINATION_BUSY',
        'Provider coordination is at capacity; retry after inactive entries expire.',
        {retry_after_ms: 60000},
        503,
        true,
      );
  }

  constructor(
    private fetcher: typeof fetch = fetch,
    private sleeper: (ms: number) => Promise<unknown> = delay,
    private timeoutMs = 30000,
    private maximumBytes = 8 * 1024 * 1024,
    private budgetBurst = 30,
    private budgetRefillMs = 250,
    private budgetWaitMs = 2000,
    private environment: 'production' | 'sandbox' = 'production',
  ) {}
  /** Custom merchant origins have no qualified sandbox route; a source reader cannot bypass that selection. */
  commerceSourceEnvironment(): 'production' | 'sandbox' {
    return this.environment;
  }
  /**
   * Shape a burst down to the sustained per-tenant rate instead of failing a bounded batch outright.
   * A bounded operation (account discovery, paged reads) may exceed the burst legitimately; only a
   * caller that stays beyond the sustained rate long enough to owe more than budgetWaitMs is rejected.
   * The refill is kept faster than Store.providerPermit's shared budget so shaping never starves it.
   */
  private async permit(key: string): Promise<void> {
    // Refill against the monotonic clock. Wall-clock time steps backwards on an NTP correction,
    // which would shrink the bucket instead of refilling it and reject a caller that owes nothing.
    const now = performance.now(),
      budget = this.budgets.get(key) ?? {tokens: this.budgetBurst, at: now};
    budget.tokens = Math.min(this.budgetBurst, budget.tokens + (now - budget.at) / this.budgetRefillMs);
    budget.at = now;
    const waitMs = budget.tokens >= 1 ? 0 : Math.ceil((1 - budget.tokens) * this.budgetRefillMs);
    if (waitMs > this.budgetWaitMs) {
      this.budgets.set(key, budget);
      throw new MirrorError(
        'TENANT_RATE_LIMIT',
        'Per-tenant platform request budget exhausted.',
        {retry_after_ms: waitMs},
        429,
        true,
      );
    }
    // Reserve before sleeping so concurrent callers queue behind each other instead of waking together.
    budget.tokens--;
    this.budgets.set(key, budget);
    if (waitMs) await this.sleeper(waitMs);
  }
  async request(
    plan: CompiledRequest,
    connection: Connection,
    credentials: Credentials,
    upload?: BinaryUpload,
    hooks: {beforeAttempt?: () => void; onDispatch?: () => void} = {},
  ): Promise<TransportResult> {
    validateGoogleRequest(plan);
    // PRV-05: every route with a pinned request schema is checked here, the last step before anything is sent. A
    // violation is counted per gateway, writes and reads apart; AMCP_WIRE_CONTRACTS=enforce also refuses it for a write.
    const wireMode = wireContractMode(),
      wire = wireContractCheck(plan, wireMode);
    if (wire?.status === 'violations' || wire?.status === 'check_failed') {
      const metric =
        wire.status === 'check_failed'
          ? 'wire_contract_check_failures'
          : plan.readOnly
            ? 'wire_contract_read_violations'
            : 'wire_contract_violations';
      if (metric === 'wire_contract_check_failures') this.metrics.wireContractCheckFailures++;
      else if (metric === 'wire_contract_read_violations') this.metrics.wireContractReadViolations++;
      else this.metrics.wireContractViolations++;
      this.coordination?.providerMetric(connection.tenantId, connection.gateway, metric);
      recordWireViolation(plan, wire);
    }
    enforceWireContract(plan, wire, wireMode);
    validateGoogleGeneration(plan);
    validateDV360TargetingSearch(plan);
    this.prune();
    const key = scopeKey(connection.tenantId, connection.gateway);
    await this.permit(key);
    // The hashed app identity these credentials draw provider quota from, counted per day and workspace (OPS-08).
    const issuer = issuerKey(connection.gateway, credentials),
      issuerPermit: IssuerPermit | undefined = issuer
        ? {
            issuer,
            tenant: connection.tenantId,
            gateway: connection.gateway,
            purpose: currentQuotaPurpose(),
            operations: requestOperations(plan.body),
          }
        : undefined;
    const url = buildUrl(plan, connection, this.environment);
    const headers: Record<string, string> = {Accept: 'application/json', ...plan.headers};
    if (plan.gateway === 'reddit_native_action') {
      if (!connection.userAgent || /[\r\n]/.test(connection.userAgent))
        throw new MirrorError(
          'USER_AGENT_REQUIRED',
          'Configure a descriptive Reddit application userAgent on the connection.',
        );
      headers['User-Agent'] = connection.userAgent;
    }
    let body: BodyInit | undefined;
    let form: URLSearchParams | undefined;
    if (upload) {
      if (plan.readOnly) throw new MirrorError('INVALID_UPLOAD', 'Binary uploads must be reviewed mutations.');
      if (upload.format === 'related') {
        if (
          plan.gateway !== 'dv360_native_action' ||
          plan.method !== 'POST' ||
          !/^\/upload\/v4\/advertisers\/\d+\/(?:assets|adAssets:uploadAdAsset)$/.test(plan.path) ||
          plan.query.uploadType !== 'multipart'
        )
          throw new MirrorError(
            'INVALID_UPLOAD',
            'Multipart-related is restricted to the DV360 advertiser asset and image ad asset contracts.',
          );
        const boundary = 'amcp_' + randomUUID();
        body = new Uint8Array(
          Buffer.concat([
            Buffer.from(
              '--' +
                boundary +
                '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(plan.body) +
                '\r\n--' +
                boundary +
                '\r\nContent-Type: ' +
                upload.mime +
                '\r\n\r\n',
            ),
            upload.bytes,
            Buffer.from('\r\n--' + boundary + '--\r\n'),
          ]),
        );
        headers['Content-Type'] = 'multipart/related; boundary=' + boundary;
      } else if (upload.format === 'fields') {
        // Snapchat chunked upload INIT and FINALIZE are multipart forms without a file part.
        if (
          plan.gateway !== 'snapchat_native_action' ||
          plan.method !== 'POST' ||
          !/^\/(?:[a-z]{2}\/)?v1\/media\/[\w-]+\/multipart-upload-v2$/.test(plan.path) ||
          !['INIT', 'FINALIZE'].includes(plan.query.action)
        )
          throw new MirrorError(
            'INVALID_UPLOAD',
            'Field-only multipart forms are restricted to the Snapchat chunked upload contract.',
          );
        const multipart = new FormData();
        for (const [k, v] of Object.entries((plan.body ?? {}) as JsonObject)) multipart.set(k, String(v));
        body = multipart;
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
      } else {
        const multipart = new FormData();
        for (const [k, v] of Object.entries((plan.body ?? {}) as JsonObject))
          multipart.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        multipart.set(upload.field, new Blob([new Uint8Array(upload.bytes)], {type: upload.mime}), upload.filename);
        body = multipart;
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
      }
    } else if (plan.body !== undefined) {
      // X's catalog reference gives products and product sets a "JSON body"; catalogs and feeds take parameters.
      const xJsonCard =
        plan.gateway === 'x_ads_native_action' &&
        ((['POST', 'PUT'].includes(plan.method) &&
          /^\/12\/accounts\/[^/]+\/cards(?:\/[^/]+)?$/.test(plan.path) &&
          !/\/cards\/(?:poll|image_conversation|video_conversation)$/.test(plan.path)) ||
          (plan.method === 'POST' && /^\/12\/accounts\/[a-z0-9]{1,32}\/audience_estimate$/.test(plan.path)) ||
          (['PUT', 'DELETE'].includes(plan.method) && /^\/12\/product_catalogs\/\d+\/products$/.test(plan.path)) ||
          (['POST', 'PUT'].includes(plan.method) &&
            /^\/12\/product_catalogs\/\d+\/product_sets(?:\/\d+)?$/.test(plan.path)));
      if (
        plan.gateway === 'meta_native_action' ||
        (plan.gateway === 'x_ads_native_action' && !plan.path.includes('/batch/') && !xJsonCard)
      ) {
        form = new URLSearchParams();
        for (const [k, v] of Object.entries(plan.body as JsonObject))
          form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        body = form.toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        let json = plan.gateway === 'google_ads_native_action' ? camelKeys(plan.body) : plan.body;
        // The Data Manager API names the manager login in each destination, where the Google Ads API takes the
        // login-customer-id header; it is the same login, from the same connection settings.
        if (plan.gateway === 'google_ads_native_action' && url.origin === 'https://datamanager.googleapis.com') {
          const login = (
            (plan.accountId ? connection.accountLoginCustomers?.[plan.accountId] : undefined) ??
            credentials.loginCustomerId
          )?.replaceAll('-', '');
          if (login && json && Array.isArray((json as JsonObject).destinations))
            json = {
              ...(json as JsonObject),
              destinations: (json as JsonObject).destinations.map((d: JsonObject) =>
                d?.operatingAccount?.accountId && d.operatingAccount.accountId !== login
                  ? {...d, loginAccount: {accountType: 'GOOGLE_ADS', accountId: login}}
                  : d,
              ),
            };
        }
        body = JSON.stringify(json);
        headers['Content-Type'] =
          plan.gateway === 'snapchat_native_action' && plan.method === 'PATCH'
            ? 'application/json-patch+json'
            : 'application/json';
      }
    }
    if (credentials.accessToken) {
      if (plan.gateway === 'tiktok_native_action') headers['Access-Token'] = credentials.accessToken;
      else headers.Authorization = 'Bearer ' + credentials.accessToken;
    }
    // The developer token and login customer are Google Ads API headers; the Data Manager API takes neither.
    if (plan.gateway === 'google_ads_native_action' && url.origin === vendorOrigins.google_ads_native_action) {
      // Google Cloud projects own API access since developer tokens were sunset on September 9, 2026. Google ignores the
      // header today and will reject it in a future major version, so a configured legacy token is never sent (PRV-04;
      // src/google-version.ts warns while AMCP_GOOGLE_DEVELOPER_TOKEN is set).
      const mapped =
        plan.action !== 'AMCP_GOOGLE_DISCOVERY' && plan.accountId
          ? connection.accountLoginCustomers?.[plan.accountId.replaceAll('-', '')]
          : undefined;
      // A website login records the manager route of every selected account when it is synced. An account without one
      // is refused with re-sync guidance: no login header, and never a deployment-wide manager guessed for it (CON-05).
      // Operator-provisioned logins, which have no recorded routes, keep their own provisioned login customer.
      if (
        mapped === undefined &&
        plan.action !== 'AMCP_GOOGLE_DISCOVERY' &&
        plan.accountId &&
        connection.accountLoginCustomers !== undefined
      )
        throw new MirrorError(
          'GOOGLE_LOGIN_CUSTOMER_UNMAPPED',
          'This Google Ads account has no recorded manager route on this login. Sync the Google Ads login in Connections, then try again.',
          {account_id: plan.accountId, connection_id: connection.id, website: '/connections'},
          409,
        );
      const loginCustomerId = mapped ?? credentials.loginCustomerId;
      if (loginCustomerId) headers['login-customer-id'] = loginCustomerId.replaceAll('-', '');
    }
    if (plan.gateway === microsoftGateway) {
      if (!credentials.developerToken)
        throw new MirrorError('DEVELOPER_TOKEN_REQUIRED', 'Microsoft Advertising requires its own developer token.');
      headers.DeveloperToken = credentials.developerToken;
      if (plan.accountId) {
        headers.CustomerAccountId = plan.accountId;
        headers.CustomerId = microsoftCustomer(connection, plan.accountId);
      } else if (
        plan.action !== 'AMCP_MICROSOFT_DISCOVERY' ||
        ![
          microsoftCustomerOrigin + '/CustomerManagement/v13/User/Query',
          microsoftCustomerOrigin + '/CustomerManagement/v13/Accounts/Search',
        ].includes(url.href)
      )
        throw new MirrorError('ACCOUNT_REQUIRED', 'Microsoft requests require an explicit selected account.');
    }
    if (plan.gateway === 'amazon_native_action') {
      if (!credentials.clientId) throw new MirrorError('CLIENT_ID_REQUIRED', 'Amazon Ads requires a client ID.');
      headers['Amazon-Advertising-API-ClientId'] = credentials.clientId;
      if (plan.accountId) headers['Amazon-Advertising-API-Scope'] = plan.accountId;
    }
    if (plan.gateway === 'apple_ads_native_action' && plan.accountId) {
      // Shared-budget mutations are organization-level methods in Apple's SDK.
      // The review layer authorizes every affected account; a header cannot scope
      // this mutation. Reads retain the optional selected-account context.
      const sharedWrite =
        url.origin === 'https://api.ads.apple.com' &&
        !plan.readOnly &&
        /^\/v1\/shared-budgets(?:\/\d+)?$/.test(plan.path);
      if (sharedWrite) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'x-ap-context') delete headers[key];
      } else
        headers['X-AP-Context'] =
          url.origin === 'https://api.ads.apple.com' && plan.path.startsWith('/v1/')
            ? 'adAccountId=' + plan.accountId + ';'
            : 'orgId=' + plan.accountId;
    }
    if (plan.gateway === 'x_ads_native_action') headers.Authorization = oauth1(plan.method, url, credentials, form);
    if (credentials.apiKey && !headers.Authorization) headers.Authorization = 'Bearer ' + credentials.apiKey;
    if (!headers.Authorization && !headers['Access-Token'])
      throw new MirrorError('CREDENTIALS_REQUIRED', 'An authenticated platform connection is required.', {}, 401);
    // Report submission creates a job even though it cannot mutate advertising configuration.
    // Generated drafts may differ on retry and consume provider generation quota.
    // Return a single attempt; callers explicitly decide whether to generate again.
    const start = performance.now(),
      circuitKey = scopeKey(key, connection.id, plan.accountId ?? '', url.origin),
      endpoint = url.pathname.replace(/\/accounts\/[^/]+/, '/accounts/:account'),
      userRateKey =
        plan.gateway === 'x_ads_native_action'
          ? scopeKey(
              key,
              'x-rate',
              sha256(credentials.accessToken ?? ''),
              url.origin,
              endpoint.startsWith('/12/stats/accounts/') ? 'analytics' : endpoint,
            )
          : key,
      // A provider throttle of one ad account (Meta 80000-series, 17/2446079, 613/1487742) cools down that account on
      // this login only; X keeps its user/account reset-header keys.
      accountRateKey = !plan.accountId
        ? userRateKey
        : plan.gateway === 'x_ads_native_action'
          ? scopeKey(userRateKey, plan.accountId)
          : scopeKey(key, 'account-rate', connection.id, plan.accountId);
    const maxAttempts =
      plan.readOnly &&
      !googleGenerationKind(plan) &&
      !(plan.gateway === microsoftGateway && plan.action === 'SubmitGenerateReport')
        ? 3
        : 1;
    const adjustRead =
      plan.gateway === 'adjust_native_action' &&
      plan.action === 'AMCP_ADJUST_REPORT_READ' &&
      plan.adjustReportRead === true &&
      plan.readOnly &&
      plan.method === 'GET' &&
      url.origin === 'https://automate.adjust.com' &&
      [
        '/reports-service/filters_data',
        '/reports-service/events',
        '/reports-service/report',
        '/reports-service/pivot_report',
      ].includes(plan.path);
    const discoveryRead =
      ((plan.action === 'AMCP_MEASUREMENT_ASSET_SYNC' &&
        ['ga4_native_action', 'google_search_console_native_action'].includes(plan.gateway)) ||
        (plan.action === 'AMCP_BUSINESS_ASSET_SYNC' && plan.gateway === 'google_business_native_action')) &&
      plan.readOnly &&
      plan.method === 'GET';
    const deadline =
      plan.gateway === 'linkedin_native_action' &&
      plan.action === 'AMCP_LINKEDIN_TEMPLATE_READ' &&
      plan.readOnly &&
      plan.method === 'GET' &&
      plan.linkedinTemplateDeadline !== undefined
        ? plan.linkedinTemplateDeadline
        : plan.gateway === 'x_ads_native_action' &&
            plan.readOnly &&
            plan.method === 'GET' &&
            plan.xTargetingDeadline !== undefined
          ? plan.xTargetingDeadline
          : plan.gateway === 'x_ads_native_action' && plan.readOnly && plan.xAudienceDeadline !== undefined
            ? plan.xAudienceDeadline
            : plan.gateway === 'snapchat_native_action' &&
                plan.readOnly &&
                plan.method === 'GET' &&
                plan.snapUpdateDeadline !== undefined
              ? plan.snapUpdateDeadline
              : plan.gateway === 'x_ads_native_action' &&
                  plan.readOnly &&
                  plan.method === 'GET' &&
                  plan.xReportDeadline !== undefined
                ? plan.xReportDeadline
                : adjustRead
                  ? plan.adjustReportDeadline
                  : discoveryRead
                    ? plan.measurementSyncDeadline
                    : plan.gateway === 'tiktok_native_action' && plan.readOnly && plan.method === 'GET'
                      ? plan.tiktokReportDeadline
                      : plan.gateway === 'criteo_native_action' && plan.readOnly && plan.method === 'GET'
                        ? plan.criteoReportRead
                          ? plan.criteoReportDeadline
                          : plan.action === 'AMCP_CRITEO_CAMPAIGN_READ'
                            ? plan.criteoCampaignDeadline
                            : undefined
                        : undefined;
    const reportDeadline = deadline !== undefined,
      deadlineFailure = () =>
        new MirrorError(
          plan.linkedinTemplateDeadline !== undefined
            ? 'LINKEDIN_TEMPLATE_LIMIT'
            : plan.xTargetingDeadline !== undefined
              ? 'X_TARGETING_LIMIT'
              : plan.xAudienceDeadline !== undefined
                ? 'X_AUDIENCE_LIMIT'
                : plan.snapUpdateDeadline !== undefined
                  ? 'SNAPCHAT_UPDATE_STATE_UNVERIFIED'
                  : plan.xReportDeadline !== undefined
                    ? 'X_REPORT_STATE_UNVERIFIED'
                    : adjustRead
                      ? 'ADJUST_REPORT_LIMIT'
                      : plan.measurementSyncDeadline !== undefined
                        ? 'ASSET_SYNC_LIMIT'
                        : plan.tiktokReportDeadline !== undefined
                          ? 'TIKTOK_REPORT_STATE_UNVERIFIED'
                          : plan.criteoReportRead
                            ? 'CRITEO_REPORT_STATE_UNVERIFIED'
                            : 'CRITEO_CAMPAIGN_STATE_UNVERIFIED',
          'Provider retrieval exceeded its monotonic deadline.',
          {},
          502,
        );
    let ownedProbe: {probing?: boolean} | undefined;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Runtime hook only: never serialize authority checks into a provider request.
        hooks.beforeAttempt?.();
        for (const rateKey of new Set([userRateKey, accountRateKey])) {
          const until = this.cooldowns.get(rateKey) ?? 0;
          if (until > performance.now())
            throw new MirrorError(
              'PLATFORM_RATE_LIMIT',
              'Provider cooldown is active; wait until the reported reset time.',
              {retry_after_ms: Math.ceil(until - performance.now())},
              429,
              true,
            );
          this.coordination?.assertProviderCooldown(rateKey);
        }
        this.coordination?.providerPermit(key, undefined, issuerPermit);
        if (attempt === 0) {
          const circuit = this.circuits.get(circuitKey),
            now = performance.now();
          if (circuit && (circuit.until > now || circuit.probing))
            throw new MirrorError(
              'CIRCUIT_OPEN',
              'Repeated transient provider failures paused this connection/account. A request will probe recovery after the cooldown.',
              {
                retry_after_ms: Math.max(1000, Math.ceil(circuit.until - now)),
                last_error_code: circuit.code,
                last_http_status: circuit.status,
              },
              503,
              true,
            );
          if (circuit?.until) {
            circuit.probing = true;
            ownedProbe = circuit;
          }
        }
        this.metrics.requests++;
        meterNativeRequest(plan.readOnly); // COM-02 C: per-step journal counts
        this.coordination?.providerMetric(connection.tenantId, connection.gateway, 'requests');
        let requestSignal: AbortSignal | undefined,
          deadlineTimer = false;
        const expired = () =>
          reportDeadline &&
          (!Number.isFinite(deadline) || performance.now() >= deadline! || (deadlineTimer && requestSignal?.aborted));
        try {
          const remaining = reportDeadline ? deadline! - performance.now() : this.timeoutMs;
          if (reportDeadline && (!Number.isFinite(remaining) || remaining <= 0)) throw deadlineFailure();
          deadlineTimer = reportDeadline && remaining <= this.timeoutMs;
          requestSignal = AbortSignal.timeout(
            collectionRequestTimeout(
              reportDeadline ? Math.max(1, Math.ceil(Math.min(this.timeoutMs, remaining))) : this.timeoutMs,
            ),
          );
          // Synchronously, with no await before the fetch: everything thrown before this line sent nothing (WRT-04).
          hooks.onDispatch?.();
          if (!plan.readOnly) markDispatched();
          const response = await this.fetcher(url, {
            method: plan.method,
            headers,
            body,
            redirect: 'error',
            signal: requestSignal,
          });
          if (expired()) {
            await response.body?.cancel();
            throw deadlineFailure();
          }
          const retryDelay = providerRetryDelay(response, plan.gateway);
          if (response.status === 429) {
            this.metrics.rateLimits++;
            this.coordination?.providerMetric(connection.tenantId, connection.gateway, 'rate_limits');
            this.issuerRateLimit(issuerPermit);
          }
          if ((response.status === 429 || response.status === 503) && retryDelay !== undefined) {
            const rateKey =
              plan.gateway === 'x_ads_native_action' && response.headers.has('x-account-rate-limit-reset')
                ? accountRateKey
                : userRateKey;
            this.cooldowns.set(rateKey, performance.now() + retryDelay);
            this.coordination?.providerCooldown(rateKey, retryDelay);
          }
          if ([502, 503, 504].includes(response.status) && retryDelay === undefined && attempt + 1 < maxAttempts) {
            await response.body?.cancel();
            this.metrics.retries++;
            await this.sleeper(200 * 2 ** attempt);
            continue;
          }
          // LinkedIn documents only the status of a tracking parameter create (201) or replace (200), keyed by the path.
          const linkedinTrackingWrite =
            plan.gateway === 'linkedin_native_action' &&
            plan.method === 'PUT' &&
            /^\/rest\/adTrackingParameters\/[^/]+$/.test(plan.path);
          const documentedEmpty =
            response.status === 200 &&
            ((plan.gateway === 'google_search_console_native_action' &&
              ['PUT', 'DELETE'].includes(plan.method) &&
              /^\/webmasters\/v3\/sites\//.test(plan.path)) ||
              (plan.gateway === 'gtm_native_action' && plan.method === 'DELETE') ||
              (plan.gateway === 'linkedin_native_action' &&
                plan.method === 'POST' &&
                plan.path === '/rest/videos' &&
                plan.query.action === 'finalizeUpload') ||
              (plan.gateway === 'google_ads_native_action' &&
                plan.method === 'POST' &&
                /^\/resumable\/upload\/v\d+\/customers\/\d+\/youTubeVideoUploads:create$/.test(plan.path) &&
                response.headers.has('x-goog-upload-url')));
          let bodyIntegrity: TransportResult['bodyIntegrity'];
          const tiktokCsv =
            plan.gateway === 'tiktok_native_action' &&
            plan.tiktokReportRead?.kind === 'download' &&
            plan.method === 'GET' &&
            plan.path === '/v1.3/report/task/download/';
          const reportOutput =
            plan.gateway === 'criteo_native_action' &&
            plan.criteoReportRead?.kind === 'output' &&
            plan.method === 'GET' &&
            criteoRoute('/reports/[a-f0-9-]+/output$', 'i').test(plan.path);
          // LinkedIn lead form IDs are 64-bit longs; keep unsafe integers as their exact source text.
          const int64 = plan.gateway === 'linkedin_native_action' && /^\/rest\/leadForms(?:\/|$)/.test(plan.path);
          let exactData: unknown;
          const data = await this.readBody(
            response,
            (adjustRead && response.status === 204) ||
              plan.method === 'HEAD' ||
              (!plan.readOnly &&
                (documentedEmpty ||
                  [204, 205].includes(response.status) ||
                  (plan.gateway === 'linkedin_native_action' &&
                    response.status === 201 &&
                    response.headers.has('x-restli-id')) ||
                  (linkedinTrackingWrite && [200, 201].includes(response.status)))),
            reportOutput || adjustRead
              ? bytes => {
                  bodyIntegrity = {bytes: bytes.length, md5: createHash('md5').update(bytes).digest('hex')};
                }
              : undefined,
            tiktokCsv,
            adjustRead,
            int64,
            losslessReportNumbers(plan),
            exact => (exactData = exact),
          );
          if (expired()) throw deadlineFailure();
          const fabric =
              plan.gateway === 'linkedin_native_action'
                ? providerReference(response.headers.get('x-li-fabric'))
                : undefined,
            taxonomy = providerErrorTaxonomyEnabled();
          const errorDetails = (c?: ProviderErrorClass) => ({
            upstream: redact(data),
            http_status: response.status,
            // A refusal only the deployment owner can lift (app_eligibility, CON-06) offers no retry time.
            ...(c?.layer === 'app_eligibility' || (c?.retryAfterMs ?? retryDelay) === undefined
              ? {}
              : {retry_after_ms: c?.retryAfterMs ?? retryDelay}),
            request_id: providerRequestId(plan.gateway, response.headers, data) ?? null,
            ...(fabric ? {provider_fabric: fabric} : {}),
            ...(c
              ? {
                  layer: c.layer,
                  ...(c.providerCode !== undefined ? {provider_code: c.providerCode} : {}),
                  ...(c.providerSubcode !== undefined ? {provider_subcode: c.providerSubcode} : {}),
                  ...(c.cooldownScope ? {cooldown_scope: c.cooldownScope} : {}),
                  // A version refusal names the version sent and the reviewed default (PRV-02).
                  ...(c.layer === 'api_version' && plan.gateway === 'linkedin_native_action'
                    ? {api_version_sent: headers['LinkedIn-Version'] ?? null, default_version: linkedinDefaultVersion}
                    : {}),
                }
              : {}),
            ...(response.status === 403
              ? {
                  scope_denial:
                    providerHttpErrorCode(403, data, response.headers.get('www-authenticate')) === 'INSUFFICIENT_SCOPE',
                }
              : {}),
            ...(plan.gateway === 'google_ads_native_action'
              ? {login_customer_id: headers['login-customer-id'] ?? null}
              : {}),
          });
          // A documented provider throttle reported outside HTTP 429 (Meta codes at HTTP 400, a Google Ads quota body)
          // counts as a rate limit and opens the shared cooldown at the scope the provider names. Nothing is retried
          // here: the error carries retry_after_ms, so neither the transport nor a worker repeats it immediately.
          const throttled = (c: ProviderErrorClass) => {
            if (c.layer !== 'rate_limit' || c.retryAfterMs === undefined) return;
            if (response.status !== 429) {
              this.metrics.rateLimits++;
              this.coordination?.providerMetric(connection.tenantId, connection.gateway, 'rate_limits');
              this.issuerRateLimit(issuerPermit);
            }
            const rateKey = c.cooldownScope === 'account' ? accountRateKey : userRateKey;
            this.cooldowns.set(rateKey, Math.max(this.cooldowns.get(rateKey) ?? 0, performance.now() + c.retryAfterMs));
            this.coordination?.providerCooldown(rateKey, c.retryAfterMs);
          };
          const classify = (inBody: boolean) => {
            if (!taxonomy) return undefined;
            const c = classifyProviderError({
              gateway: plan.gateway,
              status: response.status,
              headers: response.headers,
              body: data,
              readOnly: plan.readOnly,
              inBody,
              ...(retryDelay === undefined ? {} : {retryAfterMs: retryDelay}),
            });
            throttled(c);
            return c;
          };
          if (!response.ok) {
            const c = classify(false);
            throw new MirrorError(
              c?.code ?? providerHttpErrorCode(response.status, data, response.headers.get('www-authenticate')),
              'Platform returned HTTP ' + response.status,
              errorDetails(c),
              response.status,
              c ? c.retryable : response.status === 429 || response.status >= 500,
            );
          }
          if (data && typeof data === 'object') {
            const d = data as JsonObject;
            if (
              (plan.gateway === 'tiktok_native_action' && d.code !== undefined && d.code !== 0) ||
              d.request_status === 'ERROR' ||
              d.error ||
              (plan.gateway === 'x_ads_native_action' && Array.isArray(d.errors) && d.errors.length)
            ) {
              const c = classify(true),
                status =
                  c?.layer === 'credential'
                    ? 401
                    : c?.layer === 'rate_limit'
                      ? 429
                      : c?.layer === 'consent'
                        ? 403
                        : 502;
              throw new MirrorError(
                c?.code ?? 'PLATFORM_ERROR',
                'Platform reported an unsuccessful result.',
                errorDetails(c),
                status,
                c?.retryable ?? false,
              );
            }
          }
          googleGenerationResult(plan, data);
          if (dv360TargetingSearchRoute(plan)) dv360TargetingSearchResult(plan, data);
          this.circuits.delete(circuitKey);
          this.metrics.totalLatencyMs += performance.now() - start;
          this.coordination?.providerMetric(
            connection.tenantId,
            connection.gateway,
            'latency_ms',
            performance.now() - start,
          );
          return {
            data,
            status: response.status,
            ...(bodyIntegrity ? {bodyIntegrity} : {}),
            ...(exactData !== undefined ? {exactData} : {}),
            headers: Object.fromEntries(
              [
                'request-id',
                'x-request-id',
                'x-fb-trace-id',
                ...(plan.gateway === 'linkedin_native_action' ? ['x-li-uuid', 'x-li-request-id', 'x-li-fabric'] : []),
                'x-restli-id',
                'retry-after',
                ...(plan.gateway === 'google_ads_native_action' && plan.path.startsWith('/resumable/upload/')
                  ? ['x-goog-upload-url', 'x-goog-upload-chunk-granularity']
                  : []),
              ]
                .map(k => [k, response.headers.get(k)])
                .filter((p): p is [string, string] => p[1] !== null),
            ),
          };
        } catch (error) {
          collectionCheckpoint();
          // A timer limited by the remaining operation budget is terminal. Its abort is
          // authoritative even when performance.now() is fractionally before the deadline.
          // Shorter per-attempt timeouts may still retry within the original budget.
          const e = expired()
            ? deadlineFailure()
            : error instanceof MirrorError
              ? error
              : new MirrorError(
                  plan.readOnly ? 'UPSTREAM_UNAVAILABLE' : 'WRITE_OUTCOME_UNCERTAIN',
                  plan.readOnly
                    ? 'Platform request failed or timed out.'
                    : 'The write response was lost. Do not retry with a new key; inspect platform state.',
                  {},
                  502,
                  plan.readOnly,
                );
          if (plan.readOnly && e.retryable && e.details.retry_after_ms === undefined && attempt + 1 < maxAttempts) {
            this.metrics.retries++;
            await this.sleeper(200 * 2 ** attempt);
            continue;
          }
          this.metrics.errors++;
          this.coordination?.providerMetric(connection.tenantId, connection.gateway, 'errors');
          const transient =
            e.code === 'UPSTREAM_UNAVAILABLE' ||
            e.code === 'WRITE_OUTCOME_UNCERTAIN' ||
            (e.code === 'UPSTREAM_ERROR' && e.status >= 500);
          if (transient) {
            const prior = this.circuits.get(circuitKey)?.failures ?? 0;
            this.circuits.set(circuitKey, {
              failures: prior + 1,
              until: prior >= 4 ? performance.now() + 30000 : 0,
              at: performance.now(),
              code: e.code,
              status: e.status,
            });
          } else if (e.code !== 'PLATFORM_RATE_LIMIT' && e.details.layer !== 'rate_limit')
            // A provider throttle is governed by its cooldown: it neither counts toward nor resets the transient-failure
            // circuit, so a burst of throttles cannot clear the failures accumulated before it (PRV-01).
            this.circuits.delete(circuitKey);
          throw e;
        }
      }
      throw new MirrorError('UPSTREAM_UNAVAILABLE', 'Platform request failed.');
    } finally {
      if (ownedProbe) ownedProbe.probing = false;
    }
  }
  /** A Google-issued upload capability stays in memory and can only target Google's upload origin. */
  async uploadGoogleVideo(
    raw: string,
    bytes: Buffer,
    accessToken: string,
    options: {
      granularity?: number;
      resume?: boolean;
      beforeFinalize?: () => void;
      beforeChunk?: () => void;
      progress?: (bytes: number) => void;
    } = {},
  ): Promise<TransportResult> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new MirrorError('UNAPPROVED_UPLOAD_URL', 'Google returned an invalid upload URL.');
    }
    if (
      url.origin !== 'https://googleads.googleapis.com' ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith('/resumable/upload/')
    )
      throw new MirrorError(
        'UNAPPROVED_UPLOAD_URL',
        'Google upload URLs must stay on the Google Ads resumable upload endpoint.',
      );
    if (!accessToken)
      throw new MirrorError('CREDENTIALS_REQUIRED', 'Google video upload needs an authenticated connection.');
    const unit = options.granularity ?? 262144;
    if (!Number.isSafeInteger(unit) || unit < 1 || unit > 16 * 1024 * 1024)
      throw new MirrorError('MEDIA_RESPONSE_INVALID', 'Google returned an unsupported upload chunk granularity.');
    const chunkSize = Math.max(unit, Math.floor((4 * 1024 * 1024) / unit) * unit);
    let offset = 0,
      recoveries = 0;
    if (options.resume) {
      options.beforeChunk?.();
      let queried: Response;
      try {
        markDispatched();
        queried = await this.fetcher(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {Authorization: 'Bearer ' + accessToken, 'X-Goog-Upload-Command': 'query'},
        });
      } catch {
        throw new MirrorError('WRITE_OUTCOME_UNCERTAIN', 'The retained Google session could not be queried.');
      }
      const received = queried.headers.get('x-goog-upload-size-received');
      await queried.body?.cancel();
      offset = Number(received);
      if (
        !queried.ok ||
        received === null ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= bytes.length ||
        offset % unit !== 0
      )
        throw new MirrorError(
          'WRITE_OUTCOME_UNCERTAIN',
          'The retained upload offset is not safe to resume. Reconcile provider state.',
        );
      options.progress?.(offset);
    }

    while (offset < bytes.length) {
      options.beforeChunk?.();
      const end = Math.min(bytes.length, offset + chunkSize),
        final = end === bytes.length;
      let response: Response;
      try {
        if (final) options.beforeFinalize?.();
        markDispatched();
        response = await this.fetcher(url, {
          method: 'PUT',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'application/octet-stream',
            'X-Goog-Upload-Offset': String(offset),
            'X-Goog-Upload-Command': final ? 'upload, finalize' : 'upload',
          },
          body: new Uint8Array(bytes.subarray(offset, end)),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new MirrorError('MEDIA_UPLOAD_FAILED', 'Google video transfer returned HTTP ' + response.status);
        }
      } catch {
        // A finalization may have created the asset. Never resubmit it on a lost reply.
        if (final || recoveries++ >= 2)
          throw new MirrorError(
            'WRITE_OUTCOME_UNCERTAIN',
            'Google upload response was lost. Inspect the retained upload before any retry.',
            {bytes_confirmed: offset},
          );
        options.beforeChunk?.();
        let queried: Response;
        try {
          markDispatched();
          queried = await this.fetcher(url, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: {Authorization: 'Bearer ' + accessToken, 'X-Goog-Upload-Command': 'query'},
          });
        } catch {
          throw new MirrorError('WRITE_OUTCOME_UNCERTAIN', 'The Google upload offset could not be confirmed.');
        }
        const received = queried.headers.get('x-goog-upload-size-received');
        await queried.body?.cancel();
        const next = Number(received);
        if (
          !queried.ok ||
          received === null ||
          !Number.isSafeInteger(next) ||
          next < offset ||
          next > end ||
          next % unit !== 0
        )
          throw new MirrorError('WRITE_OUTCOME_UNCERTAIN', 'Google returned an inconsistent resumable upload offset.');
        offset = next;
        options.progress?.(offset);
        continue;
      }
      const data = await this.readBody(response, !final);
      offset = end;
      options.progress?.(offset);
      if (final) return {data, status: response.status, headers: {}};
    }
    throw new MirrorError('MEDIA_RESPONSE_INVALID', 'The upload contained no media bytes.');
  }
  /** Only signed upload URLs returned by LinkedIn's initializeUpload response. */
  async uploadLinkedIn(raw: string, bytes: Buffer, mime: string, accessToken?: string): Promise<string | undefined> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new MirrorError('INVALID_UPLOAD_URL', 'LinkedIn returned an invalid upload URL.');
    }
    if (
      url.origin !== 'https://www.linkedin.com' ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith('/dms-uploads/')
    )
      throw new MirrorError('UNAPPROVED_UPLOAD_URL', 'LinkedIn upload URL is outside the approved upload host/path.');
    if (mime.startsWith('image/') && !accessToken)
      throw new MirrorError('CREDENTIALS_REQUIRED', 'LinkedIn image uploads require an access token.');
    const headers: Record<string, string> = {
      'Content-Type': mime.startsWith('video/') ? 'application/octet-stream' : mime,
      ...(mime.startsWith('image/') ? {Authorization: 'Bearer ' + accessToken} : {}),
    };
    let response: Response;
    try {
      markDispatched();
      response = await this.fetcher(url, {
        method: 'PUT',
        headers,
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MirrorError(
        'WRITE_OUTCOME_UNCERTAIN',
        'Upload response was lost. Inspect the allocated media before retrying.',
        {},
        502,
      );
    }
    await response.body?.cancel();
    if (!response.ok)
      throw new MirrorError('MEDIA_UPLOAD_FAILED', 'LinkedIn binary upload returned HTTP ' + response.status, {}, 502);
    return response.headers.get('etag')?.replace(/^"|"$/g, '');
  }
  private async readBody(
    response: Response,
    allowEmpty: boolean,
    integrity?: (bytes: Buffer) => void,
    csv = false,
    losslessNumbers = false,
    int64 = false,
    fractionalText = false,
    exact?: (value: unknown) => void,
  ): Promise<unknown> {
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          try {
            collectionResponseBytes(value.byteLength);
          } catch (error) {
            await reader.cancel();
            throw error;
          }
          if (size > this.maximumBytes) {
            await reader.cancel();
            throw new MirrorError(
              'RESPONSE_TOO_LARGE',
              'Platform response exceeds the configured size limit. Use smaller pages.',
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    const bytes = Buffer.concat(chunks);
    let text: string;
    const declared = response.headers.get('content-length');
    if (
      csv &&
      response.ok &&
      !response.headers.has('content-encoding') &&
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) !== bytes.length)
    )
      throw new MirrorError(
        'UPSTREAM_RESPONSE_INVALID',
        'CSV transfer length differs from its declared length.',
        {},
        502,
      );
    try {
      text = integrity || csv ? new TextDecoder('utf-8', {fatal: true}).decode(bytes) : bytes.toString('utf8');
    } catch {
      throw new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Report output contains invalid UTF-8.', {}, 502);
    }
    integrity?.(bytes);
    if (csv && response.ok && !/application\/(?:[a-z0-9.+-]*\+)?json/i.test(response.headers.get('content-type') ?? ''))
      return text;
    if (!text.trim() && (!response.ok || allowEmpty)) return null;
    // Node 24's source-aware reviver preserves native int64 values even in compact
    // array rows. The checksum above covers the original bytes, never reserialized JSON.
    let data: unknown;
    try {
      data =
        integrity || losslessNumbers || int64 || fractionalText
          ? JSON.parse(text, ((_key: string, value: unknown, context?: {source: string}) =>
              typeof value === 'number' &&
              (losslessNumbers ||
                (fractionalText && !Number.isInteger(value)) ||
                (Number.isInteger(value) && !Number.isSafeInteger(value)))
                ? (context?.source ?? String(value))
                : value) as any)
          : JSON.parse(text);
      if (exact && !(integrity || losslessNumbers || int64 || fractionalText)) {
        const twin = exactIntegerJson(text);
        if (twin !== undefined) exact(twin);
      }
    } catch {
      if (!response.ok) return {content_type: response.headers.get('content-type'), body: text};
      throw new MirrorError(
        'UPSTREAM_RESPONSE_INVALID',
        'Platform returned an empty or malformed JSON response.',
        {status: response.status},
        502,
      );
    }
    if (response.ok && (data === null || typeof data !== 'object'))
      throw new MirrorError(
        'UPSTREAM_RESPONSE_INVALID',
        'Platform JSON response must contain an object or array.',
        {status: response.status},
        502,
      );
    return data;
  }
}
