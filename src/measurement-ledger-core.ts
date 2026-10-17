import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {MirrorError, providerFactDetails} from './errors.js';
import {fingerprint, obj} from './workspace-core.js';

/**
 * The shared parts of the measurement evidence ledger (MSR-03): its six fixed layers and four states, the layer record,
 * the refusal of unusable evidence, one bounded provider read under the ledger's fence, and the guard that turns a
 * failed layer read into an unknown layer. The provider adapters (Google Ads and GA4 in measurement-ledger.ts; Meta,
 * Snapchat, TikTok, Search Console and Adjust in their own files) build on these.
 */
export const measurementLedgerLayers = [
  'configuration',
  'provider_observed_activity',
  'provider_diagnostics',
  'supplied_runtime_trace',
  'consent',
  'attribution_settings',
] as const;
export const measurementLedgerStates = ['observed', 'unknown', 'unavailable', 'not_applicable'] as const;
export type LayerName = (typeof measurementLedgerLayers)[number];
export type LayerState = (typeof measurementLedgerStates)[number];
export interface Layer extends JsonObject {
  layer: LayerName;
  state: LayerState;
  reason: string;
  evidence: JsonObject | null;
  note: string;
}
/** One adapter's answer: the ledger scope, the six layers in order and every source reference. */
export interface LedgerOut {
  scope: JsonObject;
  layers: Layer[];
  source_references: JsonObject[];
}
/** The ledger's own provider collections for one adapter (pixel lists, statistics, quality and diagnostics reads). */
export const measurementLedgerReadLimits = Object.freeze({
  requests: 24,
  rows: 2000,
  bytes: 2 * 1024 * 1024,
  elapsed_ms: 60000,
});
export const layer = (name: LayerName, state: LayerState, reason: string, evidence: JsonObject | null, note: string) =>
  ({layer: name, state, reason, evidence, note}) as Layer;
export const trace = () =>
  layer(
    'supplied_runtime_trace',
    'unavailable',
    'browser_only',
    null,
    'Supplied traces are inspected only in the browser and never reach AMCP. Use Inspect a sanitized event trace on the Measurement page.',
  );
/** Evidence that is foreign, partial, malformed or outside a pinned contract is refused, never mapped. */
export function invalid(message: string): never {
  throw new MirrorError('MEASUREMENT_LEDGER_INVALID', message, {}, 502);
}

/**
 * The provider's own facts about a failed read (owner decision D21, WEB-03): its HTTP error status, error code and
 * request ID, from a provider refusal (the transport kept the provider's answer or classified its layer) or from the
 * provider envelope an adapter refused (MEASUREMENT_LEDGER_INVALID with those details). Never the provider's message or
 * body, and nothing from AMCP's own refusals.
 */
export function readFailureFacts(error: MirrorError): JsonObject {
  const d = error.details ?? {};
  if (d.upstream === undefined && typeof d.layer !== 'string' && error.code !== 'MEASUREMENT_LEDGER_INVALID') return {};
  const facts = providerFactDetails(error);
  return {
    ...(Number.isInteger(facts.http_status) && (facts.http_status as number) >= 400
      ? {http_status: facts.http_status}
      : {}),
    ...(facts.provider_code !== undefined ? {provider_code: facts.provider_code} : {}),
    ...(facts.request_id !== undefined ? {request_id: facts.request_id} : {}),
  } as JsonObject;
}
/**
 * Runs one layer read. A changed actor, login, access or control (the fence), or an exhausted whole-ledger allowance,
 * refuses the ledger; any other provider or evidence failure leaves only this layer unknown with its error code and,
 * for a provider's refusal, the provider's allow-listed facts (readFailureFacts).
 */
export async function guarded(name: LayerName, fence: () => void, ledger: string, run: () => Promise<Layer>) {
  try {
    return await run();
  } catch (error) {
    fence();
    if (!(error instanceof MirrorError)) throw error;
    if (error.code === 'REPORT_COLLECTION_LIMIT' && error.details?.definition === ledger) throw error;
    return layer(
      name,
      'unknown',
      'read_failed',
      {
        error: error.code === 'REPORT_COLLECTION_LIMIT' ? 'MEASUREMENT_LEDGER_READ_LIMIT' : error.code,
        ...readFailureFacts(error),
      },
      'This read failed or was incomplete, so the layer stays unknown.',
    );
  }
}

/** What the ledger hands an adapter: the request, the services and the ledger's own identity. */
export interface LedgerInput {
  store: Store;
  registry: Registry;
  transport: NativeTransport;
  credentials: CredentialProvider;
  actor: Actor;
  input: JsonObject;
  ledger: string;
}
/**
 * The fence of one adapter: the actor is active, the login still holds the account and its permission, and the stored
 * login is the one the ledger started with. Any change refuses the whole ledger.
 */
export function ledgerFence(
  store: Store,
  actor: Actor,
  gateway: string,
  account: string,
  connection: Connection,
  permitted: (c: Connection) => void,
) {
  permitted(connection);
  const login = fingerprint(storedLogin(store, connection));
  return () => {
    store.assertActorActive(actor);
    const now = store.resolveConnection(actor, gateway, account, connection.id);
    permitted(now);
    if (fingerprint(storedLogin(store, now)) !== login)
      throw new MirrorError(
        'CONNECTION_AUTHORITY_CHANGED',
        'The selected login changed during the read. Read the measurement ledger again.',
        {},
        409,
      );
  };
}
/** The context of one adapter's provider reads: the selected asset, its login and fence, and the adapter allowance. */
export interface ReadContext {
  store: Store;
  registry: Registry;
  transport: NativeTransport;
  actor: Actor;
  connection: Connection;
  auth: JsonObject;
  account: string;
  fence: () => void;
  budget: ReportCollectionBudget;
  references: JsonObject[];
}
export const ledgerBudget = (ledger: string, gateway: string) =>
  new ReportCollectionBudget(undefined, fingerprint({ledger, reads: gateway}), () => {}, measurementLedgerReadLimits);

/**
 * One read of the selected asset. The request is authorized (account binding and learned ownership) and the login
 * re-checked before every attempt and after the answer; a non-200 or non-object answer is refused.
 */
export async function ledgerRead(context: ReadContext, plan: CompiledRequest): Promise<JsonObject> {
  const {store, registry, transport, actor, connection, auth, fence, budget} = context,
    authority = nativeAuthority(store, registry, actor, plan, connection, auth as never, fence),
    response = await transport.request(plan, authority(), auth as never, undefined, {beforeAttempt: authority});
  authority();
  budget.check();
  if (response.status !== 200 || !obj(response.data))
    invalid('The provider returned a failed or unrecognized measurement response.');
  return response.data as JsonObject;
}
/** The source reference of one complete collection: the request and a hash of each page, never the rows. */
export function ledgerReference(resource: string, plan: CompiledRequest, pages: JsonObject[], rows: number) {
  return {
    resource,
    request: {
      method: plan.method,
      path: plan.path,
      query: plan.query,
      ...(plan.body === undefined ? {} : {body: plan.body as JsonObject}),
    },
    pages,
    collection_hash: fingerprint(pages.map(({page, rows, response_hash}) => ({page, rows, response_hash}))),
    rows,
  };
}
export const pageReference = (page: number, rows: number, data: unknown) => ({
  page,
  rows,
  response_hash: fingerprint(data),
  captured_at: Date.now(),
});

// Bounded native values. A value outside its bound is refused, never truncated or converted.
export const text = (v: unknown, max = 256): v is string =>
  typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
export const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const percentage = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
export const keysWithin = (value: JsonObject, allowed: string[]) => Object.keys(value).every(k => allowed.includes(k));

/**
 * Selection of one pixel or dataset from the account's complete list: the requested one when listed, otherwise the only
 * one. Without a selection the pixel layers stay unknown (several pixels, or a pixel not listed) or do not apply (none).
 */
export function selectPixel(ids: string[], requested: string | undefined) {
  if (requested !== undefined)
    return ids.includes(requested) ? {pixel: requested} : {reason: 'pixel_not_listed' as const};
  if (ids.length === 1) return {pixel: ids[0]!};
  return {reason: ids.length ? ('pixel_not_selected' as const) : ('no_pixels' as const)};
}
const unselectedNotes = {
  pixel_not_listed: 'The requested pixel is not listed for the selected account, so it was not read.',
  pixel_not_selected: 'The account lists several pixels. Choose one with requirements.pixel_id to read it.',
  no_pixels: 'The account lists no pixel.',
};
export const unselected = (name: LayerName, reason: keyof typeof unselectedNotes) =>
  layer(name, reason === 'no_pixels' ? 'not_applicable' : 'unknown', reason, null, unselectedNotes[reason]);
export const notPixelSetting = () =>
  layer(
    'attribution_settings',
    'not_applicable',
    'not_pixel_setting',
    null,
    'Attribution windows are chosen per ad set, ad group or report, not on the pixel.',
  );
export const noConsentSource = (provider: string) =>
  layer(
    'consent',
    'unavailable',
    'no_provider_source',
    null,
    provider +
      ' exposes no consent setting to this read. The Tag Manager audit reports the consent configuration of tags.',
  );
