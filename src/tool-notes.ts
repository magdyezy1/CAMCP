import {refusedParameters} from './parameters.js';
import {googleAdsVersion} from './google-version.js';
import type {ToolDefinition} from './types.js';

/**
 * Captured gateway descriptions stay verbatim, for parity with the captured catalog; where one names a tool, a
 * behaviour or a version AMCP does not have, an "AMCP note" follows it (F-30). The listed schemas are unchanged:
 * validation and the parity tests read the captured ones, and a refused parameter still answers with its own reason.
 */
export function amcpNote(tool: ToolDefinition): string | undefined {
  const text = tool.description ?? '',
    properties = Object.keys(tool.inputSchema?.properties ?? {}),
    notes: string[] = [];
  if (/Prefer named tools/.test(text))
    notes.push(
      'Its named tools are amcp_campaign for a launch, amcp_write for one reviewed change, amcp_media for uploads and amcp_reporting for performance.',
    );
  if (/dv360_reporting_ops/.test(text)) notes.push('There is no dv360_reporting_ops tool and no DV360 reporting.');
  if (tool.mode === 'direct' && properties.includes('dry_run'))
    notes.push(
      'Nothing is written from this tool, whatever dry_run says: a write action returns its compiled request as a preview and a media upload returns a review; amcp_write prepare and execute make the change.',
    );
  const refused = properties.filter(k => refusedParameters.includes(k));
  if (refused.length)
    notes.push(
      (refused.length > 1 ? refused.slice(0, -1).join(', ') + ' and ' + refused.at(-1) + ' are' : refused[0] + ' is') +
        ' refused unless false.',
    );
  if (tool.name === 'google_ads_native_action')
    notes.push(
      'Requests go to Google Ads API ' +
        googleAdsVersion +
        '; action names keep their recorded google_ads_v23_ spelling.',
    );
  return notes.length ? 'AMCP note: ' + notes.join(' ') : undefined;
}
/** The description a caller is shown: the captured text, then its AMCP note. */
export const describedTool = (tool: ToolDefinition): string => {
  const note = amcpNote(tool);
  return note ? tool.description + ' ' + note : tool.description;
};
