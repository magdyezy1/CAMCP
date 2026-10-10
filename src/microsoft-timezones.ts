import {MirrorError} from './errors.js';
import {zonedMidnight} from './workflows.js';
import type {JsonObject} from './types.js';

/**
 * RPT-04 (owner policy P6): Microsoft Advertising Overview totals use the account's own time zone. Microsoft names its
 * zones with a `ReportTimeZone` enum (pinned in generated/microsoft-contracts.json) and returns the account zone as a
 * Customer Management `TimeZoneType` value, which spells four zones differently. Each enum value maps to one IANA
 * zone, chosen from the zone's named cities and Microsoft's documented offset; tests check the table against the
 * pinned enum. An unknown or missing account zone falls back to London, with a warning.
 */
export const microsoftReportTimeZones: Readonly<Record<string, string>> = Object.freeze({
  Nukualofa: 'Pacific/Tongatapu',
  FijiKamchatkaMarshallIsland: 'Pacific/Fiji',
  AucklandWellington: 'Pacific/Auckland',
  MagadanSolomonIslandNewCaledonia: 'Pacific/Guadalcanal',
  Vladivostok: 'Asia/Vladivostok',
  Hobart: 'Australia/Hobart',
  GuamPortMoresby: 'Pacific/Port_Moresby',
  CanberraMelbourneSydney: 'Australia/Sydney',
  Brisbane: 'Australia/Brisbane',
  Darwin: 'Australia/Darwin',
  Adelaide: 'Australia/Adelaide',
  Yakutsk: 'Asia/Yakutsk',
  Seoul: 'Asia/Seoul',
  OsakaSapporoTokyo: 'Asia/Tokyo',
  Taipei: 'Asia/Taipei',
  Perth: 'Australia/Perth',
  KualaLumpurSingapore: 'Asia/Singapore',
  IrkutskUlaanBataar: 'Asia/Irkutsk',
  BeijingChongqingHongKongUrumqi: 'Asia/Shanghai',
  Krasnoyarsk: 'Asia/Krasnoyarsk',
  BangkokHanoiJakarta: 'Asia/Bangkok',
  Rangoon: 'Asia/Yangon',
  SriJayawardenepura: 'Asia/Colombo',
  AstanaDhaka: 'Asia/Dhaka',
  AlmatyNovosibirsk: 'Asia/Omsk',
  Kathmandu: 'Asia/Kathmandu',
  ChennaiKolkataMumbaiNewDelhi: 'Asia/Kolkata',
  IslandamabadKarachiTashkent: 'Asia/Karachi',
  Ekaterinburg: 'Asia/Yekaterinburg',
  Kabul: 'Asia/Kabul',
  BakuTbilisiYerevan: 'Asia/Baku',
  AbuDhabiMuscat: 'Asia/Dubai',
  Tehran: 'Asia/Tehran',
  Nairobi: 'Africa/Nairobi',
  MoscowStPetersburgVolgograd: 'Europe/Moscow',
  KuwaitRiyadh: 'Asia/Riyadh',
  Baghdad: 'Asia/Baghdad',
  Jerusalem: 'Asia/Jerusalem',
  HelsinkiKyivRigaSofiaTallinnVilnius: 'Europe/Helsinki',
  HararePretoria: 'Africa/Johannesburg',
  Cairo: 'Africa/Cairo',
  Bucharest: 'Europe/Bucharest',
  AthensIslandanbulMinsk: 'Europe/Athens',
  WestCentralAfrica: 'Africa/Lagos',
  SarajevoSkopjeWarsawZagreb: 'Europe/Warsaw',
  BrusselsCopenhagenMadridParis: 'Europe/Paris',
  BelgradeBratislavaBudapestLjubljanaPrague: 'Europe/Budapest',
  AmsterdamBerlinBernRomeStockholmVienna: 'Europe/Berlin',
  CasablancaMonrovia: 'Africa/Monrovia',
  GreenwichMeanTimeDublinEdinburghLisbonLondon: 'Europe/London',
  Azores: 'Atlantic/Azores',
  CapeVerdeIsland: 'Atlantic/Cape_Verde',
  MidAtlantic: 'Atlantic/South_Georgia',
  Brasilia: 'America/Sao_Paulo',
  BuenosAiresGeorgetown: 'America/Argentina/Buenos_Aires',
  Greenland: 'America/Nuuk',
  Newfoundland: 'America/St_Johns',
  AtlanticTimeCanada: 'America/Halifax',
  CaracasLaPaz: 'America/Caracas',
  Santiago: 'America/Santiago',
  BogotaLimaQuito: 'America/Bogota',
  EasternTimeUSCanada: 'America/New_York',
  IndianaEast: 'America/Indiana/Indianapolis',
  CentralAmerica: 'America/Guatemala',
  CentralTimeUSCanada: 'America/Chicago',
  GuadalajaraMexicoCityMonterrey: 'America/Mexico_City',
  Saskatchewan: 'America/Regina',
  Arizona: 'America/Phoenix',
  ChihuahuaLaPazMazatlan: 'America/Mazatlan',
  MountainTimeUSCanada: 'America/Denver',
  PacificTimeUSCanadaTijuana: 'America/Los_Angeles',
  Alaska: 'America/Anchorage',
  Hawaii: 'Pacific/Honolulu',
  MidwayIslandandSamoa: 'Pacific/Pago_Pago',
  InternationalDateLineWest: 'Etc/GMT+12',
});
/** Customer Management `TimeZoneType` spellings that differ from the Reporting `ReportTimeZone` enum. */
export const microsoftAccountTimeZoneAliases: Readonly<Record<string, string>> = Object.freeze({
  AthensBuckarestIstanbul: 'AthensIslandanbulMinsk',
  IslamabadKarachiTashkent: 'IslandamabadKarachiTashkent',
  SolomonIslandNewCaledonia: 'MagadanSolomonIslandNewCaledonia',
  MidwayIslandAndSamoa: 'MidwayIslandandSamoa',
});
export const microsoftFallbackReportTimeZone = 'GreenwichMeanTimeDublinEdinburghLisbonLondon';
export const microsoftFallbackWarning =
  'Microsoft did not return a recognized account time zone, so report days use GreenwichMeanTimeDublinEdinburghLisbonLondon (Europe/London, including daylight saving).';

/** The `ReportTimeZone` and IANA zone for a Microsoft account `TimeZone`, or the warned London fallback. */
export function microsoftReportZone(accountTimeZone: unknown): {
  report_time_zone: string;
  timezone: string;
  fallback: boolean;
} {
  const named =
    typeof accountTimeZone === 'string'
      ? (microsoftAccountTimeZoneAliases[accountTimeZone] ?? accountTimeZone)
      : undefined;
  if (named && Object.hasOwn(microsoftReportTimeZones, named))
    return {report_time_zone: named, timezone: microsoftReportTimeZones[named]!, fallback: false};
  return {
    report_time_zone: microsoftFallbackReportTimeZone,
    timezone: microsoftReportTimeZones[microsoftFallbackReportTimeZone]!,
    fallback: true,
  };
}

/** After a report day ends Microsoft may still be completing it; a deferred or 2004 run is retried this much later. */
export const microsoftCompleteDataDelayMs = 3600000;
const localDate = (at: number, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(at);
/**
 * `ReturnOnlyCompleteData` is invalid for a period that includes the account's current day. A window ending today in
 * the account time zone is deferred (retryable `REPORT_PENDING` after the day ends); a later end date is refused.
 */
export function assertMicrosoftWindowClosed(range: {until: string}, timezone: string, now = Date.now()) {
  const next = new Date(Date.parse(range.until + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  let closes: number;
  try {
    closes = zonedMidnight(next, timezone, true);
  } catch {
    // A skipped local midnight (daylight saving at 00:00) uses the latest possible civil boundary.
    closes = zonedMidnight(next, 'Etc/GMT+12', true);
  }
  if (now >= closes) return;
  const closesAt = new Date(closes).toISOString();
  if (range.until > localDate(now, timezone))
    throw new MirrorError(
      'INVALID_REPORT_RANGE',
      'Microsoft Advertising returns complete data only for days that have ended in the account time zone. Choose an end date no later than today.',
      {window_closes_at: closesAt, timezone},
      422,
    );
  throw new MirrorError(
    'REPORT_PENDING',
    'Microsoft Advertising returns complete data only after the last report day ends in the account time zone. AMCP collects this source after that day ends.',
    {
      retry_after_ms: closes - now + microsoftCompleteDataDelayMs,
      window_closes_at: closesAt,
      timezone,
      deferred: true,
    },
    503,
    true,
  );
}
/** Whether a Microsoft error body carries a given operation error code (bounded search). */
export function microsoftErrorCode(upstream: unknown, code: number, depth = 0): boolean {
  if (!upstream || typeof upstream !== 'object' || depth > 3) return false;
  if (Array.isArray(upstream)) return upstream.slice(0, 20).some(v => microsoftErrorCode(v, code, depth + 1));
  const value = upstream as JsonObject;
  if (String(value.Code ?? value.code ?? '') === String(code)) return true;
  return ['Errors', 'OperationErrors', 'BatchErrors', 'PartialErrors', 'error', 'Detail', 'detail'].some(key =>
    microsoftErrorCode(value[key], code, depth + 1),
  );
}
/** Maps Microsoft's "complete data is not yet available" refusal (operation error 2004) to a retryable pending state. */
export async function microsoftCompleteData<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof MirrorError && microsoftErrorCode(e.details?.upstream, 2004))
      throw new MirrorError(
        'REPORT_PENDING',
        'Microsoft Advertising has not finished the data for this window yet. AMCP retries later.',
        {retry_after_ms: microsoftCompleteDataDelayMs, provider_code: '2004'},
        503,
        true,
      );
    throw e;
  }
}
