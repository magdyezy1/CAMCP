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
export function reportPreset(input: JsonObject, context?: {overviewV4?: true}): JsonObject {
  const preset = reportPresets.find(p => p.id === input.preset);
  if (!preset) bad('Choose a supported capture preset.');
  const platform = presetPlatform.get(preset.id)!;
  if (input.campaign_id !== undefined && !platform.campaignFilter?.(preset))
    bad('A campaign filter requires a qualified parent-scoped Snapchat preset.');
  const range = dateRange({since: input.semantics?.date_from, until: input.semantics?.date_to}, windowKeys);
  return platform.presetRequest!(preset, input, range, context);
}
