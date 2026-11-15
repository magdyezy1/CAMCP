import {dateRange} from './workflows.js';
import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {guidedReportSources} from './report-sources.js';

/**
 * The guided capture presets (amcp_reporting capture_presets and capture_preset). Each platform's presets, the native
 * read each defines and the checks of its evidence rows are its guided reporting's (ARC-04 stage F: the report sources'
 * `guided`, src/<platform>-guided-reports.ts); this module lists the presets in the registry's guided order and keeps
 * the shared checks of a capture: the preset, the campaign filter and the reporting window, in that order.
 */
const guided = guidedReportSources.map(source => source.guided!);
export const reportPresets = guided.flatMap(platform => platform.presets!);
const presetPlatform = new Map(guided.flatMap(platform => platform.presets!.map(preset => [preset.id, platform])));
/** The keys of `semantics` a capture's window is read from. A refusal of its dates names them (R25 M0, owner 2026-11-15). */
const windowKeys = {since: 'semantics.date_from', until: 'semantics.date_to'};

/** Guided evidence must retain its requested native hierarchy, reporting window and grain. */
export function validatePresetRows(preset: string | undefined, input: JsonObject, rows: JsonObject[]) {
  // The platform whose presets the capture's preset is named under checks its rows (LinkedIn, Meta).
  guided.find(platform => preset?.startsWith(platform.presetPrefix!))?.validateRows?.(preset!, input, rows);
}
/**
 * The window of a worked call in the help: seven closed days that end two days ago in UTC. That is a closed window in any
 * timezone and inside every platform's limit, whatever day the help is read, so a worked call never goes stale (R25 M0).
 */
function exampleWindow(today: Date): {date_from: string; date_to: string} {
  const day = (offset: number) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset))
      .toISOString()
      .slice(0, 10);
  return {date_from: day(8), date_to: day(2)};
}
/**
 * What amcp_reporting capture_preset help adds to its contract (R25 M0, owner 2026-11-15, observation 7 of the live checks, which
 * took six failed calls to learn the keys of `semantics`): one worked call for each platform with guided presets, and the rules
 * of that platform that the call keeps. Each platform declares its own (`GuidedReporting.help`); the call's `semantics` is built
 * here from a closed window and the platform's values, leaving out the keys its preset sets itself.
 */
export function capturePresetHelp(today: Date = new Date()): JsonObject {
  const window = exampleWindow(today);
  return {
    worked_examples: guided.flatMap(platform => {
      const help = platform.help;
      if (!help || !platform.presetPrefix) return [];
      const semantics: JsonObject = {
        ...window,
        timezone: help.timezone,
        currency: help.currency,
        complete: true,
        attribution: 'unknown',
        source_name: help.source,
      };
      for (const key of help.sets ?? []) delete semantics[key];
      return [
        {
          platform: platform.presetPrefix.replace(/_$/, ''),
          call: {
            tool: 'amcp_reporting',
            arguments: {
              action: 'capture_preset',
              preset: help.preset,
              account_id: help.account,
              ...help.arguments,
              semantics,
            },
          },
          rules: [...help.rules],
        },
      ];
    }),
    worked_examples_meaning:
      'Each call is complete as written: its window is seven closed days that ended before today, inside the platform’s limit. Replace the account, timezone, currency and source_name with the ones of the account you capture; the capture checks the timezone and currency against the platform’s own and refuses a different one.',
  };
}
export function reportPreset(input: JsonObject, context?: {overviewV4?: true}): JsonObject {
  const preset = reportPresets.find(p => p.id === input.preset);
  if (!preset) bad('Choose a supported capture preset.');
  const platform = presetPlatform.get(preset.id)!;
  if (input.campaign_id !== undefined && !platform.campaignFilter?.(preset))
    bad('A campaign filter requires a qualified parent-scoped Snapchat preset.');
  const range = dateRange({since: input.semantics?.date_from, until: input.semantics?.date_to}, windowKeys);
  return platform.presetRequest!(preset, input, range, context);
}
