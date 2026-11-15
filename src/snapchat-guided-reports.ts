import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import type {GuidedReporting} from './report-source.js';
import {
  collectSnapchatEvidence,
  snapchatDailyRange,
  snapchatReportId,
  snapchatWindowsTaken,
} from './snapchat-evidence.js';
import {snapchatAllocationEvidence} from './snapchat-allocation-evidence.js';
import {snapchatAllocationDraft} from './snapchat-allocation-draft.js';

/**
 * Snapchat's guided reporting (ARC-04 stage F): its capture presets (purchases and native lead submissions by
 * campaign, ad squad and ad) and the stats read each defines. Snapchat's report source declares it; src/report-presets.ts
 * lists the presets and keeps the shared checks.
 */
const leadPresets = ['snapchat_campaign_leads', 'snapchat_adsquad_leads', 'snapchat_ad_leads'];
const presets = [
  ...['campaign', 'adsquad', 'ad'].map(level => ({
    id: 'snapchat_' + level,
    name: 'Snapchat ' + (level === 'adsquad' ? 'ad squad' : level) + ' performance',
    level,
    grain: (level === 'adsquad' ? 'ad squad' : level) + ' × day',
    gateway: 'snapchat_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Account-local daily purchases with explicit swipe/view attribution, conversion-time reporting and total conversion sources. Account identity, currency and timezone are checked before and after complete bounded pages. Each page must confirm delivery and conversion processing through the requested end. Uses swipes for clicks and exact spend micros. Requires 1–31 closed days and whole-hour local midnight boundaries. Missing metrics stay unknown; no conversion-value or creative-assignment claim.',
  })),
  ...['campaign', 'adsquad', 'ad'].map(level => ({
    id: 'snapchat_' + level + '_leads',
    name: 'Snapchat ' + (level === 'adsquad' ? 'ad squad' : level) + ' native lead submissions',
    level,
    grain: (level === 'adsquad' ? 'ad squad' : level) + ' × day',
    gateway: 'snapchat_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Account-local daily native_leads counts for submitted Snapchat lead forms. No submitted lead records are read. Exact spend micros and swipes remain separate. Account identity, currency and timezone are checked before and after complete bounded pages; ad squads and ads require an exact owned parent campaign. Each page must confirm non-conversion metric finalization through the requested end. Requires 1–31 closed days and whole-hour local midnight boundaries. Missing counts stay unknown. Pixel/MMP attribution, lead quality and historical creative assignment are not established.',
  })),
];
/** The parent-scoped presets: ad squads, and native lead submissions by ad, read one exact campaign's stats. */
const parentScoped = (preset: JsonObject) =>
  preset.level === 'adsquad' || (leadPresets.includes(preset.id) && preset.level === 'ad');

export const snapchatGuidedReporting: GuidedReporting = {
  presets,
  presetPrefix: 'snapchat_',
  // What amcp_reporting capture_preset help shows of Snapchat's presets (R25 M0, owner 2026-11-15, observation 7 of the live checks).
  help: {
    preset: 'snapchat_campaign',
    account: '00000000-0000-4000-8000-000000000000',
    timezone: 'America/Los_Angeles',
    currency: 'USD',
    source: 'Snapchat Ads campaign stats',
    arguments: {swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'},
    sets: ['attribution'],
    rules: [
      'The window is 1–31 closed days in the account timezone: semantics.date_to must be a day that has already ended there.',
      'semantics.complete must be true: it declares that the window has closed and its data is complete.',
      'swipe_up_attribution_window is 1_DAY, 7_DAY or 28_DAY, and view_attribution_window is none, 1_HOUR, 3_HOUR, 6_HOUR, 1_DAY or 7_DAY; a seven-day view needs at least a seven-day swipe window. semantics.attribution is set from them: leave it out.',
      'Snapchat may report other windows than the ones asked for: the refusal then names the pair it used, and asking for that pair matches it.',
      'The native lead presets (snapchat_campaign_leads and the ad squad and ad ones) take neither window argument. The ad squad presets, and the ad lead preset, take the exact parent campaign_id.',
      'semantics.timezone and semantics.currency are the ad account’s own; the capture refuses a different one.',
    ],
  },
  campaignFilter: parentScoped,
  // DEC-01: an allocation models parent-bound ad-squad evidence, with the exact campaign ownership it was read under.
  allocation: {
    preset: 'snapchat_adsquad',
    evidence: snapchatAllocationEvidence,
    entity: snapchatReportId,
  },
  presetRequest(preset, input, _range, context) {
    const leads = leadPresets.includes(preset.id),
      parent = parentScoped(preset);
    if (!snapchatReportId(input.account_id)) bad('Use the exact Snapchat advertising account UUID.');
    if (parent && !snapchatReportId(input.campaign_id)) bad('Choose the exact Snapchat parent campaign UUID.');
    const swipe = input.swipe_up_attribution_window,
      view = input.view_attribution_window;
    if (leads && (swipe !== undefined || view !== undefined))
      bad('Native lead-form submissions do not use the purchase attribution window controls.');
    if (!leads && !snapchatWindowsTaken(swipe, view))
      bad(
        'Choose explicit supported Snapchat swipe and view attribution windows; a seven-day view requires at least a seven-day swipe window.',
      );
    const days = snapchatDailyRange(input.semantics, context?.overviewV4 === true);
    return {
      gateway: preset.gateway,
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: {
        action: parent ? 'snapchat_campaign_stats_get' : 'snapchat_account_stats_get',
        path_params: parent ? {campaign_id: input.campaign_id} : {ad_account_id: input.account_id},
        aggregate_pages: false,
        query: {
          granularity: 'DAY',
          breakdown: preset.level,
          start_time: new Date(days[0]!.start).toISOString(),
          end_time: new Date(days.at(-1)!.end).toISOString(),
          fields:
            context?.overviewV4 && !leads
              ? [
                  'spend',
                  'impressions',
                  'swipes',
                  'total_installs',
                  'video_views',
                  'video_views_15s',
                  'story_opens',
                  'landing_page_views',
                  'native_leads',
                  'conversion_page_views',
                  'conversion_add_cart',
                  'conversion_purchases',
                  'conversion_sign_ups',
                ].join(',')
              : 'spend,impressions,swipes,' + (leads ? 'native_leads' : 'conversion_purchases'),
          ...(!leads
            ? {
                swipe_up_attribution_window: swipe,
                view_attribution_window: view,
                action_report_time: 'conversion',
                conversion_source_types: 'total',
              }
            : {}),
          omit_empty: false,
          limit: 200,
        },
      },
      semantics: {
        ...input.semantics,
        attribution: leads
          ? 'Snapchat native form submissions; no off-platform attribution claim'
          : 'Snapchat ' + swipe + ' swipe / ' + view + ' view; conversion time; total sources',
        conversion_definition: leads
          ? 'native_leads (submitted native lead forms)'
          : 'conversion_purchases (total sources)',
      },
      rows_pointer: '/data/data/rows',
      mapping: {
        entity_id: '/entity_id',
        date: '/date',
        spend: {path: '/stats/spend', divisor: 1000000},
        impressions: '/stats/impressions',
        clicks: '/stats/swipes',
        conversions: '/stats/' + (leads ? 'native_leads' : 'conversion_purchases'),
      },
    };
  },
  // ARC-01 (reporting): a capture of a Snapchat preset collects complete daily stats pages (src/snapchat-evidence.ts).
  // The Overview's job cache may hold the account's proven campaign population (src/snapchat-overview-detail.ts); a
  // capture the user makes (no job cache) keeps every check.
  collect: ({store, call, actor, args, semantics, allowPartial, overviewV4, lookup}) =>
    collectSnapchatEvidence(store, call, actor, args, semantics, {
      allowPartial,
      overviewV4,
      ...(overviewV4 && lookup?.snapchatPopulation ? {population: lookup.snapchatPopulation.byId} : {}),
    }),
  sourceCollection: 'snapchat_daily_pages',
  semanticsSource: (_preset, request) =>
    request.arguments.query.fields === 'spend,impressions,swipes,native_leads'
      ? 'Snapchat account identity, currency and timezone verified before and after complete daily pages. Native submitted-form counts use native_leads; every page confirms non-conversion metric finalization through the selected end. Swipes are clicks; spend is native micros. No submitted lead records are read. Collection is not a point-in-time snapshot; off-platform attribution, lead quality and measurement setup remain unverified.'
      : 'Snapchat account identity, currency and timezone verified before and after complete daily pages. Explicit swipe/view windows, conversion-time reporting and total conversion sources come from the retained request; each page confirms delivery and conversion processing through the selected end. Swipes are clicks; spend is native micros. Collection is not a point-in-time snapshot or proof of measurement setup.',
  // Wave 4c round 6 (w4c-arc6-reporting): DEC-02's native budget draft of the allocation model (ad squad budgets).
  allocationDraft: snapchatAllocationDraft,
};
