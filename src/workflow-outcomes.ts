import type {JsonObject} from './types.js';

/** Additive metadata for first-party workflows. Native provider payloads never choose UI routes or next actions. */
export function workflowOutcome(tool: string | undefined, data: JsonObject): JsonObject | undefined {
  if (
    !['amcp_campaign', 'amcp_media', 'amcp_reporting', 'amcp_reporting_overview', 'amcp_workspace'].includes(
      tool ?? '',
    ) ||
    !data ||
    typeof data !== 'object'
  )
    return;
  const raw = data.attention_state ?? data.state ?? data.status ?? data.decision ?? data.run?.state;
  const state = ['complete', 'verified', 'verified_with_acceptance', 'available', 'resolved'].includes(raw)
    ? 'complete'
    : ['uncertain', 'mismatch', 'failed', 'inconclusive', 'open', 'attention'].includes(raw)
      ? 'attention_required'
      : ['blocked', 'cancelled', 'expired'].includes(raw)
        ? 'blocked'
        : ['running', 'queued', 'processing', 'verifying', 'executing'].includes(raw)
          ? 'running'
          : data.execute_requirements || data.review || data.approval || ['prepared', 'review_ready'].includes(raw)
            ? 'review_required'
            : ['snoozed', 'acknowledged', 'paused', 'superseded'].includes(raw)
              ? 'deferred'
              : 'inspect';
  const result: JsonObject = {version: 1, state, source_state: raw ?? null, automatic_retry_of_mutation: false};
  const id = data.campaign_id ?? data.report_id ?? data.review_id ?? data.id;
  if (tool === 'amcp_workspace') {
    if (Array.isArray(data.operations)) result.website_path = '/operations';
    else if (data.record_kind === 'workbook_report' && typeof data.id === 'string')
      result.website_path = '/operations?run_id=' + encodeURIComponent(data.id);
    else if (data.record_kind === 'workbook_schedule' && typeof data.id === 'string')
      result.website_path = '/operations?workbook_schedule_id=' + encodeURIComponent(data.id);
    else if (['incident', 'monitor'].includes(data.record_kind) && typeof data.id === 'string')
      result.website_path = '/monitors?' + data.record_kind + '_id=' + encodeURIComponent(data.id);
    else if (Array.isArray(data.incidents) || Array.isArray(data.monitors)) result.website_path = '/monitors';
  }
  if (typeof id === 'string' && id.length <= 160) {
    const route =
      tool === 'amcp_campaign'
        ? '/campaigns?id='
        : tool === 'amcp_media'
          ? '/media?review_id='
          : tool === 'amcp_reporting'
            ? '/reports?id='
            : tool === 'amcp_reporting_overview' && data.state
              ? '/reporting-overview?report_id='
              : null;
    if (route) result.website_path = route + encodeURIComponent(id);
  }
  if (data.next_call) result.next_call = data.next_call;
  if (data.execute_requirements)
    result.required_acknowledgements = Object.keys(data.execute_requirements).filter(
      k => data.execute_requirements[k] === true,
    );
  return result;
}
