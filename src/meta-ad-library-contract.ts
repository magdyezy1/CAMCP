import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {metaPrefix} from './meta-version.js';

/**
 * The fixed Meta Ad Library read contract (ARC-04): the search arguments it accepts and the one Graph request it allows.
 * ScopeGuard authorizes the archive read by this predicate; src/meta-ad-library.ts runs the search through ScopeGuard.
 * The two lived in one module, so it and src/scope.ts imported each other; the contract is a leaf now.
 */
const invalid = (message: string, code = 'INVALID_AD_LIBRARY_SEARCH'): never => {
  throw new MirrorError(code, message);
};
export const metaAdLibraryFields = [
  'id',
  'page_id',
  'page_name',
  'ad_creation_time',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_captions',
  'ad_creative_link_descriptions',
  'publisher_platforms',
];
const countries = new Set(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK'.split(
    ' ',
  ),
);
// ISO codes absent from Meta's documented ad_reached_countries enum.
for (const country of ['CU', 'IR', 'KP', 'SD']) countries.delete(country);
/** The archive query of validated search arguments; refuses anything outside the contract. */
export function metaAdLibraryQuery(args: JsonObject): JsonObject {
  if (
    Object.keys(args).some(k => !['search_term', 'country', 'ad_type', 'limit'].includes(k)) ||
    typeof args.search_term !== 'string' ||
    !args.search_term.trim() ||
    [...args.search_term].length > 100 ||
    /[\u0000-\u001f]/.test(args.search_term)
  )
    invalid('Use a search term of 1–100 characters without control characters.');
  const country = args.country ?? 'US',
    media = args.ad_type ?? 'ALL',
    limit = args.limit ?? 25;
  if (
    !countries.has(country) ||
    !['ALL', 'IMAGE', 'VIDEO', 'MEME'].includes(media) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    invalid('Choose an uppercase ISO country, ALL/IMAGE/VIDEO/MEME media filter and limit 1–100.');
  return {
    search_terms: args.search_term,
    ad_reached_countries: [country],
    ad_type: 'ALL',
    media_type: media,
    ad_active_status: 'ACTIVE',
    fields: metaAdLibraryFields.join(','),
    limit,
  };
}
/** Public archive access is independent of advertiser ownership. This exception
 * permits only the fixed read contract, never arbitrary Graph or Page requests. */
export function metaAdLibraryRead(p: CompiledRequest): boolean {
  if (
    p.gateway !== 'meta_native_action' ||
    p.action !== 'AMCP_META_AD_LIBRARY_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    p.specialTransport ||
    p.path !== metaPrefix + 'ads_archive' ||
    p.origin !== 'https://graph.facebook.com' ||
    Object.keys(p.headers).length
  )
    return false;
  const q = p.query;
  if (
    Object.keys(q).some(
      k =>
        ![
          'search_terms',
          'ad_reached_countries',
          'ad_type',
          'media_type',
          'ad_active_status',
          'fields',
          'limit',
          'after',
        ].includes(k),
    ) ||
    !Array.isArray(q.ad_reached_countries) ||
    q.ad_reached_countries.length !== 1 ||
    q.ad_type !== 'ALL' ||
    q.ad_active_status !== 'ACTIVE' ||
    q.fields !== metaAdLibraryFields.join(',')
  )
    return false;
  try {
    metaAdLibraryQuery({
      search_term: q.search_terms,
      country: q.ad_reached_countries[0],
      ad_type: q.media_type,
      limit: q.limit,
    });
  } catch {
    return false;
  }
  return (
    q.after === undefined ||
    (typeof q.after === 'string' && q.after.length > 0 && q.after.length <= 4096 && !/[\u0000-\u001f]/.test(q.after))
  );
}
