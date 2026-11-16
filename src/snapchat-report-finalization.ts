import type {JsonObject} from './types.js';

/**
 * Shown when an empty Snapchat answer (no ad squads) left out its finalization times and nothing in the same read says that
 * Snapchat's data is final through the end of the window (r12-fix, the lead's ruling on item 1, decision 2, 2026-11-16). One
 * sentence for the report's warnings and for quality.population.unconfirmed_reason, in words for people and for agents (WEB-03:
 * no argument, field or tool name). It names no count: the count is quality.population.unconfirmed_empty_campaigns.
 */
export const snapchatUnconfirmedEmptyWarning =
  'For part of this source, Snapchat returned no rows and did not say that its data is final through the end of the window, so AMCP cannot tell no delivery from data Snapchat has not processed yet. That part is left out and never counted as zero, so this source is partial. Run the report again once Snapchat has finalized the window, or choose an earlier window.';

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const instant = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);
/** The pages a capture kept of the stats it read (src/snapchat-evidence.ts), from the lineage of its assembled result. */
const pagesOf = (result: JsonObject): JsonObject[] =>
  Array.isArray(result.lineage)
    ? result.lineage.filter(entry => object(entry) && Number.isSafeInteger(entry.entity_count))
    : [];

/**
 * How many campaigns of an all-campaign read have an empty answer that nothing confirms. Snapchat answers a campaign that did not
 * deliver with no ad squads and leaves out the finalization times (the capture marks such a page `finalization_stated: false`), so
 * "no rows" for it is not yet known to be "no delivery": the data may be unprocessed. AMCP's rule is that unknown stays unknown,
 * never zero, so an empty answer without times is "no rows" only when the end of its window is covered by a finalization time from
 * evidence in the same read: the earliest time, of those the answers with ad squads in the whole collection state, for finalized
 * non-conversion data and for processed conversion data. An empty answer that states its own times needs none (it is not marked),
 * and does not serve as evidence for another. A campaign counts once, however many of its answers (spans of a long window) are
 * unconfirmed. What cannot be read is never taken as confirmation.
 *
 * `results` are the assembled results of the campaigns that were read; no provider request is made to find evidence.
 */
export function unconfirmedEmptyCampaigns(results: readonly JsonObject[]): number {
  const campaigns = results.map(pagesOf);
  let earliest: number | undefined;
  for (const pages of campaigns)
    for (const page of pages)
      if (page.entity_count > 0)
        for (const time of [instant(page.finalized_data_end_time), instant(page.conversion_data_processed_end_time)])
          if (Number.isFinite(time) && (earliest === undefined || time < earliest)) earliest = time;
  return campaigns.filter(pages =>
    pages.some(
      page =>
        page.entity_count === 0 &&
        page.finalization_stated === false &&
        !(earliest !== undefined && earliest >= instant(page.source_request?.query?.end_time)),
    ),
  ).length;
}
