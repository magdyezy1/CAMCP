import type {CompiledRequest, JsonObject} from './types.js';
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
 * - Provider-observed activity: GET /v1.3/pixel/event/stats/ exists in the captured catalog, but its response is not in
 *   any primary document AMCP could read (the official Business API SDK leaves its data unspecified, checked
 *   2026-10-11). The layer is unavailable and no request is sent until a native read under ACC-06 pins it.
 * - TikTok exposes no event-quality diagnostics or consent setting to these reads; attribution windows belong to ad
 *   groups, not pixels.
 */
const gateway = 'tiktok_native_action',
  listPath = '/v1.3/pixel/list/',
  pageSize = 20,
  maxPages = 10;
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

async function pixels(context: ReadContext) {
  const rows: JsonObject[] = [],
    seen = new Set<string>(),
    pages: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > maxPages) invalid('The advertiser lists more pixels than one ledger reads.');
    const data = await ledgerRead(context, plan(context.account, page)),
      d = data.data;
    if (data.code !== 0 || !obj(d) || !Array.isArray(d.pixels) || d.pixels.length > pageSize)
      invalid('TikTok returned a failed, partial or unrecognized pixel list.');
    const info = obj(d.page_info) ? (d.page_info as JsonObject) : {},
      pagesTotal = info.total_page ?? 1,
      number = info.total_number;
    if (
      !Number.isSafeInteger(pagesTotal) ||
      pagesTotal < 0 ||
      (number !== undefined && (!Number.isSafeInteger(number) || number < 0)) ||
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
    if (page === total && number !== undefined && number !== rows.length)
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
    context: ReadContext = {store, registry, transport, actor, connection, auth, account, fence, budget, references};
  let selection: ReturnType<typeof selectPixel> | undefined;
  let configuration;
  try {
    configuration = await guarded('configuration', fence, ledger, () =>
      budget.run(async () => {
        const listed = await pixels(context);
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
  } finally {
    budget.close();
  }
  fence();
  return {
    scope: {gateway, connection_id: connection.id, account_id: account, pixel_id: selection?.pixel ?? null},
    layers: [
      configuration,
      layer(
        'provider_observed_activity',
        'unavailable',
        'unpinned_contract',
        null,
        'TikTok pixel event statistics have no primary response contract AMCP could pin, so they are not read.',
      ),
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
