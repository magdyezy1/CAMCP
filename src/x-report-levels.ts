/** Provider-owned hierarchy shared by the current declaration and the legacy level lookup. */
export const xOverviewLevels = [
  {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
  {id: 'adset', label: 'Line item', native_type: 'line_item', preset: 'x_line_item'},
  {id: 'ad', label: 'Promoted tweet', native_type: 'promoted_tweet', preset: 'x_promoted_tweet'},
];
export type XAnalyticsEntity = 'CAMPAIGN' | 'LINE_ITEM' | 'PROMOTED_TWEET';
