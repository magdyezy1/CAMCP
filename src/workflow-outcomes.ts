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
          : data.execute_requirements ||
              data.review ||
              data.approval ||
              data.approval_required === true ||
              ['prepared', 'review_ready'].includes(raw)
            ? 'review_required'
            : ['snoozed', 'acknowledged', 'paused', 'superseded'].includes(raw)
              ? 'deferred'
              : 'inspect';
  const result: JsonObject = {version: 1, state, source_state: raw ?? null, automatic_retry_of_mutation: false};
  const id = data.campaign_id ?? data.report_id ?? data.review_id ?? data.id;
  if (tool === 'amcp_campaign' && data.record_kind === 'recipe_eligibility')
    result.website_path = '/campaigns#campaign-create';
  if (
    tool === 'amcp_media' &&
    data.record_kind === 'native_asset_references' &&
    typeof data.asset_id === 'string' &&
    data.asset_id.length <= 160
  ) {
    result.website_path = '/media?asset_id=' + encodeURIComponent(data.asset_id);
    const imageViews: JsonObject = {
      ad_images: 'ad_group_ad_asset_view',
      performance_max: 'asset_group_asset',
      performance_max_brand: 'campaign_asset',
    };
    if (
      data.platform === 'google_ads' &&
      data.complete === true &&
      typeof data.reference_view === 'string' &&
      Object.hasOwn(imageViews, data.reference_view) &&
      data.qualified_view === imageViews[data.reference_view] &&
      Number.isSafeInteger(data.selected_limit) &&
      data.selected_limit >= 1 &&
      data.selected_limit <= 1000
    )
      result.website_path +=
        '&reference_view=' + encodeURIComponent(data.reference_view) + '&reference_limit=' + data.selected_limit;
    if (
      data.platform === 'snapchat' &&
      data.complete === true &&
      data.reference_view === 'snapchat_top_snap' &&
      data.qualified_view === 'creative.top_snap_media_id' &&
      Number.isSafeInteger(data.selected_limit) &&
      data.selected_limit >= 1 &&
      data.selected_limit <= 1000
    )
      result.website_path += '&reference_view=snapchat_top_snap&reference_limit=' + data.selected_limit;
    if (data.has_more === true && typeof data.next_cursor === 'string' && Number.isInteger(data.page_size))
      result.next_call = {
        tool: 'amcp_media',
        arguments: {action: 'asset_usage', asset_id: data.asset_id, limit: data.page_size, cursor: data.next_cursor},
      };
  }
  if (tool === 'amcp_workspace') {
    if (Array.isArray(data.operations)) result.website_path = '/operations';
    else if (data.record_kind === 'portfolio') result.website_path = '/portfolio';
    else if (data.record_kind === 'audit_history') result.website_path = '/activity';
    else if (data.record_kind === 'catalog_comparison') {
      const query = ['connection_id', 'account_id', 'catalog_id']
        .filter(key => typeof data.scope?.[key] === 'string' && data.scope[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(data.scope[key]))
        .join('&');
      result.website_path = '/commerce?catalog_comparison=1' + (query ? '&' + query : '');
    } else if (
      data.record_kind === 'catalog_source' &&
      data.scope?.gateway === 'commerce_native_action' &&
      data.complete_selected_evidence === true &&
      Array.isArray(data.product_ids) &&
      data.product_ids.length >= 1 &&
      data.product_ids.length <= 50 &&
      data.product_ids.every((id: unknown) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)) &&
      new Set(data.product_ids).size === data.product_ids.length &&
      ['price', 'regular_price', 'sale_price'].includes(data.scope?.price_field)
    ) {
      const query = ['connection_id', 'account_id']
        .filter(key => typeof data.scope?.[key] === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.scope[key]))
        .map(key => key + '=' + encodeURIComponent(data.scope[key]));
      if (query.length === 2)
        result.website_path =
          '/commerce?woo_source=1&' +
          query.join('&') +
          '&product_ids=' +
          encodeURIComponent(data.product_ids.join(',')) +
          '&price_field=' +
          data.scope.price_field;
    } else if (data.record_kind === 'measurement_events') result.website_path = '/measurement';
    else if (data.record_kind === 'measurement_event_identity') {
      const values = {
        ...data.scope,
        account_id: data.scope?.property_id,
        expected_count: data.observation?.declared_expected_count,
      };
      const query = [
        'connection_id',
        'account_id',
        'event_name',
        'test_id',
        'date_from',
        'date_to',
        'stream_id',
        'expected_count',
      ]
        .filter(key => typeof values[key] === 'string' && values[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(values[key]))
        .join('&');
      result.website_path = '/measurement?event_identity=1' + (query ? '&' + query : '');
    } else if (data.record_kind === 'conversion_rules') {
      const query = ['connection_id', 'account_id']
        .filter(key => typeof data.scope?.[key] === 'string' && data.scope[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(data.scope[key]))
        .join('&');
      result.website_path = '/measurement?conversion_rules=1' + (query ? '&' + query : '');
    } else if (data.record_kind === 'measurement_audit') {
      const query = ['connection_id', 'account_id', 'container_id', 'workspace_id']
        .filter(key => typeof data.scope?.[key] === 'string' && data.scope[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(data.scope[key]))
        .join('&');
      result.website_path = '/measurement' + (query ? '?' + query : '');
    } else if (data.record_kind === 'workbook_report' && typeof data.id === 'string')
      result.website_path = '/operations?run_id=' + encodeURIComponent(data.id);
    else if (data.record_kind === 'workbook_schedule' && typeof data.id === 'string')
      result.website_path = '/operations?workbook_schedule_id=' + encodeURIComponent(data.id);
    else if (['incident', 'monitor'].includes(data.record_kind) && typeof data.id === 'string')
      result.website_path = '/monitors?' + data.record_kind + '_id=' + encodeURIComponent(data.id);
    else if (data.record_kind === 'monitor_notifications' && typeof data.monitor_id === 'string')
      result.website_path = '/monitors?monitor_id=' + encodeURIComponent(data.monitor_id);
    else if (data.record_kind === 'monitor_notice' && typeof data.incident_id === 'string')
      result.website_path = '/monitors?incident_id=' + encodeURIComponent(data.incident_id);
    else if (['workbook_query', 'workbook_query_preview'].includes(data.record_kind) && typeof data.id === 'string')
      result.website_path = '/operations?query_id=' + encodeURIComponent(data.id);
    else if (data.record_kind === 'workbook_query_move_preview' && typeof data.id === 'string')
      result.website_path = '/operations?move_query_id=' + encodeURIComponent(data.id);
    else if (data.record_kind === 'workbook_queries') result.website_path = '/operations?queries=1';
    else if (
      ['workbook_binding', 'workbook_binding_preview', 'workbook_binding_state_preview'].includes(data.record_kind) &&
      typeof data.id === 'string'
    )
      result.website_path = '/operations?workbook_binding_id=' + encodeURIComponent(data.id);
    else if (data.record_kind === 'workbook_bindings') result.website_path = '/operations?bindings=1';
    else if (Array.isArray(data.incidents) || Array.isArray(data.monitors)) result.website_path = '/monitors';
  }
  if (typeof id === 'string' && id.length <= 160) {
    const route =
      tool === 'amcp_campaign'
        ? '/campaigns?id='
        : tool === 'amcp_media'
          ? '/media?review_id='
          : tool === 'amcp_reporting'
            ? ['allocation_plan', 'search_exclusion_plan'].includes(data.record_kind)
              ? '/campaigns?id='
              : '/reports?id='
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
