import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError, providerFactDetails} from './errors.js';
import {optionalPinnedJson} from './pinned-json.js';
import {ScopeGuard} from './scope.js';
import {bad, obj} from './workspace-core.js';
import {
  guarded,
  invalid,
  layer,
  ledgerBudget,
  ledgerFence,
  ledgerRead,
  ledgerReference,
  noConsentSource,
  notPixelSetting,
  pageReference,
  selectPixel,
  text,
  trace,
  unselected,
  type Layer,
  type LedgerInput,
  type LedgerOut,
  type ReadContext,
} from './measurement-ledger-core.js';

/**
 * The TikTok adapter of the measurement evidence ledger (MSR-03 slice D, owner direction P8). Read-only; no Events API
 * call, no test event and no write.
 * - Configuration: GET /v1.3/pixel/list/ of the selected advertiser in bounded pages (the "Get pixels" contract the pixel
 *   family already relies on, checked 2026-09-26: pixel_id, pixel_name, pixel_code and asset_ownership). Pixel IDs are
 *   exact strings; an unsafe JSON number is refused rather than rounded.
 * - Provider-observed activity: GET /v1.3/pixel/event/stats/, TikTok's "Get Pixel Event statistics" (Events 1.0 Pixel
 *   Events reference), for the selected pixel. Its request comes from TikTok's official Business API SDK specification
 *   (tiktok/tiktok-business-api-sdk, yml_files/pixel_event_stats.yml, read 2026-10-17): advertiser_id, pixel_ids (an
 *   array of numeric IDs) and date_range {start_date, end_date}, each JSON-encoded in the query; the dates have no
 *   documented format, so AMCP sends the last seven complete UTC days as YYYY-MM-DD (a guess, not a documented format).
 *   The specification leaves the answer's `data` unspecified ("checked in the document for the API"), and the portal
 *   page's response table is drawn by TikTok's scripts, which AMCP did not run. AMCP sends a provider request only as a
 *   pinned document states it (F-50; PRV-06 C's hashed SDK files, CMP-03's optional Learn page), so this read is sent
 *   only once the deployment has pinned that specification: the commit of TikTok's SDK repository, the file's sha256
 *   and the request fields it documents, recorded by tools/tiktok-event-stats-pin.mjs in
 *   .mirror/VENDOR/tiktok-pixel-event-stats.json (an optional capture). Until then, or when the pin documents another method, path or fields than AMCP sends, the layer
 *   is unavailable (`unpinned_request`) and nothing is sent. Once pinned, the answer is checked only for what is
 *   documented (the code/message/request_id/data envelope) and for safety (bounded size and depth, safe numbers, no
 *   other pixel or advertiser), then returned field by field as TikTok sent it. The layer stays unknown
 *   (`unconfirmed_fields`): AMCP names no field's meaning and never reports activity as observed until an owner-run
 *   native read (ACC-06) confirms the fields and their date basis. A failed envelope keeps TikTok's own code and
 *   request ID (WEB-03's allow-listed provider facts), never its message.
 * - TikTok exposes no event-quality diagnostics or consent setting to these reads; attribution windows belong to ad
 *   groups, not pixels.
 */
const gateway = 'tiktok_native_action',
  listPath = '/v1.3/pixel/list/',
  statsPath = '/v1.3/pixel/event/stats/',
  pageSize = 20,
  maxPages = 10;
/** Bounds of the unconfirmed statistics answer: refused whole beyond them, never truncated. */
export const tiktokEventStatsLimits = Object.freeze({fields: 200, depth: 6, items: 100, characters: 128, days: 7});
/**
 * The pinned SDK specification of the statistics request, as tools/tiktok-event-stats-pin.mjs records it from a local
 * copy of the file at one commit. What AMCP sends must be exactly what it documents.
 */
export const tiktokEventStatsSpec = Object.freeze({
  repository: 'tiktok/tiktok-business-api-sdk',
  path: 'yml_files/pixel_event_stats.yml',
  method: 'GET',
  request_path: '/open_api' + statsPath,
  query: Object.freeze(['advertiser_id', 'date_range', 'pixel_ids']),
  date_range: Object.freeze(['end_date', 'start_date']),
});
let installedPin: unknown | null | undefined;
/** Tests install a synthetic pin (null: none); `undefined` reads the committed capture again. */
export function setTiktokEventStatsPinForTest(pin: unknown | null | undefined): void {
  installedPin = pin;
}
const sameSet = (value: unknown, expected: readonly string[]) =>
  Array.isArray(value) && value.length === expected.length && [...value].sort().every((v, i) => v === expected[i]);
/**
 * Whether the statistics read may be sent: `pinned` when the capture names the SDK file at a full commit with its
 * sha256 and documents exactly the method, path, query fields and date range fields AMCP sends (no date format, or the
 * YYYY-MM-DD AMCP sends); `unpinned` without a capture; `differs` (with the first problem) for any other capture.
 */
export function tiktokEventStatsPin(
  envelope: unknown = installedPin === undefined
    ? optionalPinnedJson('.mirror/VENDOR/tiktok-pixel-event-stats.json')
    : installedPin,
): {status: 'pinned'; source: JsonObject} | {status: 'unpinned'} | {status: 'differs'; problem: string} {
  if (envelope === undefined || envelope === null) return {status: 'unpinned'};
  const spec = tiktokEventStatsSpec,
    pin = obj(envelope) ? (envelope as JsonObject) : {},
    source = obj(pin.source) ? (pin.source as JsonObject) : {},
    request = obj(pin.request) ? (pin.request as JsonObject) : {},
    commit = typeof source.commit === 'string' && /^[0-9a-f]{40}$/.test(source.commit) ? source.commit : undefined;
  const checks: [string, boolean][] = [
    ['schema_version', pin.schema_version === 1],
    ['source_file', source.repository === spec.repository && source.path === spec.path],
    ['source_commit', !!commit],
    [
      'source_url',
      source.url === 'https://raw.githubusercontent.com/' + spec.repository + '/' + commit + '/' + spec.path,
    ],
    ['source_sha256', typeof source.sha256 === 'string' && /^[0-9a-f]{64}$/.test(source.sha256)],
    ['checked_at', typeof source.checked_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.checked_at)],
    ['request_route', request.method === spec.method && request.path === spec.request_path],
    ['request_query', sameSet(request.query, spec.query)],
    ['request_date_range', sameSet(request.date_range, spec.date_range)],
    ['request_date_format', request.date_format === null || request.date_format === 'YYYY-MM-DD'],
  ];
  const problem = checks.find(([, ok]) => !ok)?.[0];
  if (problem) return {status: 'differs', problem};
  return {
    status: 'pinned',
    source: {
      repository: spec.repository,
      path: spec.path,
      commit: commit!,
      sha256: source.sha256 as string,
      checked_at: source.checked_at as string,
    },
  };
}
/** TikTok's failed or unrecognized envelope: AMCP's own reason, with TikTok's code and request ID when it named them. */
function envelopeRefusal(data: JsonObject, message: string): never {
  throw new MirrorError(
    'MEASUREMENT_LEDGER_INVALID',
    message,
    providerFactDetails({
      details: {...(data.code !== 0 ? {provider_code: data.code} : {}), request_id: data.request_id},
    }),
    502,
  );
}
/**
 * One TikTok ledger read. TikTok names its request ID in the answer's body (code, message, request_id, data), not in a
 * header, so a refusal the transport raised from that answer (it keeps the redacted body as `upstream`) gets the ID
 * from there; the ledger keeps it only as an allow-listed fact (readFailureFacts).
 */
async function tiktokRead(context: ReadContext, request: CompiledRequest): Promise<JsonObject> {
  try {
    return await ledgerRead(context, request);
  } catch (error) {
    const details = error instanceof MirrorError ? error.details : undefined,
      upstream = details && obj(details.upstream) ? (details.upstream as JsonObject) : undefined,
      id = providerFactDetails({details: {request_id: upstream?.request_id}}).request_id;
    if (details && (details.request_id === undefined || details.request_id === null) && id !== undefined)
      details.request_id = id;
    throw error;
  }
}
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const pixelId = (v: unknown) =>
  numeric(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
const plan = (account: string, page: number): CompiledRequest => ({
  gateway,
  accountId: account,
  action: 'tiktok_pixel_list_get',
  method: 'GET',
  path: listPath,
  query: {advertiser_id: account, page, page_size: pageSize},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  evidence: 'Measurement ledger read of one selected TikTok advertiser',
  warnings: [],
});

/** The last seven complete UTC days, as the YYYY-MM-DD dates TikTok's date_range takes. */
export function tiktokStatsWindow(now = Date.now()) {
  const day = 86400000,
    end = Math.floor(now / day) * day - day;
  return {
    start_date: new Date(end - (tiktokEventStatsLimits.days - 1) * day).toISOString().slice(0, 10),
    end_date: new Date(end).toISOString().slice(0, 10),
  };
}
const statsPlan = (account: string, pixel: string, window: JsonObject): CompiledRequest => ({
  gateway,
  accountId: account,
  action: 'tiktok_pixel_event_stats',
  method: 'GET',
  path: statsPath,
  query: {advertiser_id: account, pixel_ids: JSON.stringify([pixel]), date_range: JSON.stringify(window)},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  evidence: 'Measurement ledger read of one selected TikTok pixel',
  warnings: [],
});
/**
 * TikTok's statistics answer as it came, one entry per value (`stats[0].count` style paths), within the bounds. A key
 * that names a pixel or the advertiser must name the selected ones; anything else is returned literally, not
 * interpreted.
 */
export function unconfirmedFields(data: unknown, own: {pixel: string; code: string | null; advertiser: string}) {
  const limits = tiktokEventStatsLimits,
    fields: {path: string; value: string | number | boolean | null}[] = [];
  const own_id = (key: string, value: unknown) => {
    const literal = typeof value === 'number' ? String(value) : value;
    if (['pixel_id', 'pixel_ids'].includes(key) && literal !== own.pixel)
      invalid('TikTok returned statistics of another pixel.');
    if (key === 'advertiser_id' && literal !== own.advertiser)
      invalid('TikTok returned statistics of another advertiser.');
    if (key === 'pixel_code' && own.code !== null && literal !== own.code)
      invalid('TikTok returned statistics of another pixel.');
  };
  const walk = (value: unknown, path: string, key: string, depth: number) => {
    if (depth > limits.depth) invalid('TikTok returned pixel event statistics nested deeper than one ledger reads.');
    if (Array.isArray(value)) {
      if (value.length > limits.items) invalid('TikTok returned more pixel event statistics than one ledger reads.');
      value.forEach((item, i) => walk(item, path + '[' + i + ']', key, depth + 1));
      return;
    }
    if (obj(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) invalid('TikTok returned a malformed statistics field name.');
        walk(child, path ? path + '.' + name : name, name, depth + 1);
      }
      return;
    }
    // A value is kept only as it can be shown exactly: no rounded integer, no control character, no long text.
    const exact =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' &&
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) ||
      (typeof value === 'string' && (value === '' || text(value, limits.characters)));
    if (!exact) invalid('TikTok returned an unsafe number or an unreadable value in its pixel event statistics.');
    own_id(key, value);
    if (fields.length >= limits.fields) invalid('TikTok returned more pixel event statistics than one ledger reads.');
    fields.push({path, value: value as string | number | boolean | null});
  };
  walk(data, '', '', 0);
  return fields;
}
/**
 * The selected pixel's statistics read, sent only as the pinned specification documents it: the documented envelope
 * checked, every field returned unconfirmed, and the pinned file the request followed named.
 */
async function eventStats(context: ReadContext, pixel: string, code: string | null, specification: JsonObject) {
  const window = tiktokStatsWindow(),
    read = statsPlan(context.account, pixel, window),
    data = await tiktokRead(context, read);
  if (data.code !== 0 || !Object.hasOwn(data, 'data') || (data.data !== null && !obj(data.data)))
    envelopeRefusal(data, 'TikTok returned a failed or unrecognized pixel event statistics response.');
  const fields = unconfirmedFields(data.data ?? {}, {pixel, code, advertiser: context.account});
  context.budget.rows('pixel_event_stats', fields.length);
  context.references.push(
    ledgerReference('pixel_event_stats', read, [pageReference(0, fields.length, data)], fields.length),
  );
  return {
    pixel_id: pixel,
    window: {...window, day_basis: 'unconfirmed'},
    field_count: fields.length,
    fields,
    field_meanings: 'unconfirmed',
    request_specification: specification,
  };
}

async function pixels(context: ReadContext) {
  const rows: JsonObject[] = [],
    seen = new Set<string>(),
    pages: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > maxPages) invalid('The advertiser lists more pixels than one ledger reads.');
    const data = await tiktokRead(context, plan(context.account, page)),
      d = data.data;
    if (data.code !== 0 || !obj(d) || !Array.isArray(d.pixels) || d.pixels.length > pageSize)
      envelopeRefusal(data, 'TikTok returned a failed, partial or unrecognized pixel list.');
    // The page totals are required: without them a partial list could not be told from a complete one.
    const info = obj(d.page_info) ? (d.page_info as JsonObject) : {},
      pagesTotal = info.total_page,
      number = info.total_number;
    if (
      !Number.isSafeInteger(pagesTotal) ||
      pagesTotal < 0 ||
      !Number.isSafeInteger(number) ||
      number < 0 ||
      (page > 1 && pagesTotal !== total)
    )
      invalid('TikTok returned an invalid or changing page count.');
    if (page === 1) total = Math.max(pagesTotal as number, 1);
    for (const row of d.pixels as unknown[]) {
      const r = obj(row) ? row : invalid('A TikTok pixel row is malformed.'),
        id = pixelId(r.pixel_id);
      if (
        !id ||
        seen.has(id) ||
        (r.pixel_name !== undefined && !text(r.pixel_name)) ||
        (r.pixel_code !== undefined &&
          (typeof r.pixel_code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.pixel_code))) ||
        (r.asset_ownership !== undefined && !obj(r.asset_ownership))
      )
        invalid('A TikTok pixel row is malformed or repeated.');
      seen.add(id!);
      const own = obj(r.asset_ownership) ? (r.asset_ownership as JsonObject) : {};
      rows.push({
        pixel_id: id!,
        pixel_name: r.pixel_name ?? null,
        pixel_code: r.pixel_code ?? null,
        owned:
          own.ownership_status === undefined
            ? null
            : own.ownership_status === true && !['SHARED', 'UNBOUND'].includes(own.asset_relation_status),
      });
    }
    context.budget.rows('pixels:' + page, (d.pixels as unknown[]).length);
    pages.push(pageReference(page, (d.pixels as unknown[]).length, data));
    if (page === total && number !== rows.length)
      invalid('The native count shows the TikTok pixel list is incomplete.');
  }
  context.references.push(ledgerReference('pixel_list', plan(context.account, 1), pages, rows.length));
  return rows.sort((a, b) => String(a.pixel_id).localeCompare(String(b.pixel_id)));
}

export async function tiktokLedger({
  store,
  registry,
  transport,
  credentials,
  actor,
  input,
  ledger,
}: LedgerInput): Promise<LedgerOut> {
  const account = input.account_id;
  if (!numeric(account)) bad('Choose the exact numeric TikTok advertiser ID.');
  const requested = (input.requirements as JsonObject | undefined)?.pixel_id as string | undefined;
  if (requested !== undefined && !numeric(requested)) bad('Choose the exact numeric TikTok pixel ID.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  new ScopeGuard(registry, store).authorize(plan(account, 1), connection);
  // TikTok permissions are set on the developer app; the fence checks the actor, the account grant and the login.
  const fence = ledgerFence(store, actor, gateway, account, connection, () => {});
  fence();
  const auth = (await credentials.get(connection)) as unknown as JsonObject;
  fence();
  const references: JsonObject[] = [],
    budget = ledgerBudget(ledger, gateway),
    context: ReadContext = {store, registry, transport, actor, connection, auth, account, fence, budget, references},
    statsPin = tiktokEventStatsPin();
  let selection: ReturnType<typeof selectPixel> | undefined, listed: JsonObject[] | undefined;
  let configuration, activity: Layer;
  try {
    configuration = await guarded('configuration', fence, ledger, () =>
      budget.run(async () => {
        listed = await pixels(context);
        selection = selectPixel(
          listed.map(p => p.pixel_id as string),
          requested,
        );
        return listed.length
          ? layer(
              'configuration',
              'observed',
              'pixels_listed',
              {
                pixels: listed.slice(0, 20),
                pixel_count: listed.length,
                selected_pixel: selection.pixel ?? null,
                ...(selection.reason ? {selection: selection.reason} : {}),
              },
              'The pixels the advertiser lists, and whether it owns each one or has it shared.',
            )
          : layer(
              'configuration',
              'not_applicable',
              'no_pixels',
              {pixels: [], pixel_count: 0, selected_pixel: null},
              'The advertiser lists no pixel.',
            );
      }),
    );
    fence();
    const pixel = selection?.pixel;
    activity =
      !listed || !selection
        ? layer(
            'provider_observed_activity',
            'unknown',
            'configuration_unknown',
            null,
            'Without the pixel list, no pixel is read.',
          )
        : statsPin.status !== 'pinned'
          ? layer(
              'provider_observed_activity',
              'unavailable',
              'unpinned_request',
              statsPin.status === 'differs' ? {pin: 'differs', problem: statsPin.problem} : null,
              statsPin.status === 'differs'
                ? 'AMCP sends TikTok pixel event statistics only as the pinned copy of TikTok’s SDK specification documents the request, and the pinned copy documents another request than AMCP sends, so they are not read.'
                : 'AMCP sends TikTok pixel event statistics only as a pinned copy of TikTok’s SDK specification documents the request, and this deployment has not pinned it (tools/tiktok-event-stats-pin.mjs), so they are not read.',
            )
          : !pixel
            ? unselected('provider_observed_activity', selection.reason!)
            : await guarded('provider_observed_activity', fence, ledger, () =>
                budget.run(async () =>
                  layer(
                    'provider_observed_activity',
                    'unknown',
                    'unconfirmed_fields',
                    await eventStats(
                      context,
                      pixel,
                      (listed!.find(p => p.pixel_id === pixel)?.pixel_code as string | null | undefined) ?? null,
                      statsPin.source,
                    ),
                    'TikTok returned its pixel event statistics, shown as they came: no primary document AMCP could read names the response fields, so AMCP does not interpret them, and the layer stays unknown until an owner-run read confirms their meaning.',
                  ),
                ),
              );
  } finally {
    budget.close();
  }
  fence();
  return {
    scope: {gateway, connection_id: connection.id, account_id: account, pixel_id: selection?.pixel ?? null},
    layers: [
      configuration,
      activity,
      layer(
        'provider_diagnostics',
        'unavailable',
        'no_provider_source',
        null,
        'TikTok exposes no event quality diagnostics to AMCP.',
      ),
      trace(),
      noConsentSource('TikTok'),
      notPixelSetting(),
    ],
    source_references: references,
  };
}
