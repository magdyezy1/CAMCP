// P2B-02 (differential review, wave 5 round 2 part 2b), the rendered kind `report-pdf-export`: the names a provider controls, with a
// combining mark directly after a space and directly after a no-break space, in Latin and in Arabic. Each failed the whole export of
// a report PDF, on every retry, until the shaped PDF text measured and drew them (src/pdf-text.ts, src/report-artifacts.ts). All
// synthetic: the granular fixture's fake Meta account answers with them instead of its own names.
import {granularRange, granularSource} from './overview-granularity-data.mjs';

export const hostileNames = Object.freeze({
  // U+0301, COMBINING ACUTE ACCENT, after U+0020 and after U+00A0.
  latinSpace: 'Spring ́ sale',
  latinNoBreak: 'Spring ́ sale',
  // U+064B, ARABIC FATHATAN, after U+0020 and after U+00A0.
  arabicSpace: 'حملة ً الصيف',
  arabicNoBreak: 'حملة ً الصيف',
});
/**
 * The campaign, ad set and ad of the report, by the language of the page that runs it. Over the two pages all four names stand
 * as an entity of the report; the entity rows (the campaign and the ad) are what the PDF names.
 */
export const providerNamesFor = Object.freeze({
  en: Object.freeze({
    campaign: hostileNames.latinSpace,
    adset: hostileNames.arabicSpace,
    ad: hostileNames.latinNoBreak,
  }),
  ar: Object.freeze({
    campaign: hostileNames.arabicSpace,
    adset: hostileNames.latinNoBreak,
    ad: hostileNames.arabicNoBreak,
  }),
});
/** The text a PDF reader of the tests returns for a name: its white space (a no-break space too) read as one space. */
export const asRead = name => name.replace(/\s+/gu, ' ');
/** A name as a message shows it: every character above ASCII by its code point, so a space and a no-break space differ. */
export const inCodePoints = name =>
  [...name]
    .map(c => (c.codePointAt(0) > 126 ? 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : c))
    .join('');

/** The run the report editor sends for one account's campaign and ad levels, the selected ad being the fake provider's own. */
export function reportPdfExportConfig() {
  const meta = granularSource('meta');
  return {
    contract_version: 'overview-config-v4',
    partial_delivery: 'allow_marked',
    name: 'PDF export check',
    client_name: '',
    grain: 'total',
    sources: [
      {
        platform: 'meta',
        connection_id: meta.connection_id,
        account_id: meta.account_id,
        objective_fallback: 'sales',
        native_metrics: [],
        level: 'campaign',
        levels: ['campaign', 'ad'],
        statuses: ['all'],
        delivered_only: false,
        report_options: {attribution: 'unknown', ...meta.report_options},
        campaign_ids: [],
        adset_ids: [],
        ad_ids: ['9007199254740993'],
      },
    ],
    date_range: granularRange,
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'],
    custom_metrics: [],
    targets: {},
    objectives: [],
  };
}
/** The presentation of a report pack as its form saves it, for one PDF and Excel language. */
export const presentationFor = language => ({
  brand_name: '',
  accent_color: '#354B67',
  template: 'standard',
  artifact_language: language,
  footer: '',
});
