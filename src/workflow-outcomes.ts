import type {JsonObject} from './types.js';

/**
 * What following a suggested call does (MCP-09): whether it reaches a provider, which AMCP records it may save, and that
 * it changes no advertising account. It labels the effects the called action already has and changes none of them:
 * `amcp_workspace check` with live:false makes no request and saves nothing; with live:true it reads the provider
 * account and saves the shared account-read evidence (`readiness`, CON-03) and the account's metadata.
 * `program_check` with live:true keeps one timestamped observation of the read (CON-04, owner decision D20); with
 * live:false it saves nothing. `saves` is the most a call saves: a read that fails before the provider answers, or a
 * login without an account read, saves less. Calls it does not know are left unlabelled rather than guessed.
 */
export function callEffects(call: {tool?: unknown; arguments?: JsonObject}): JsonObject | undefined {
  const args = call.arguments ?? {},
    live = args.live === true,
    effects = (provider_requests: 'none' | 'read_only', saves: string[]) => ({
      provider_requests,
      saves,
      advertising_writes: 0,
    });
  if (call.tool !== 'amcp_workspace') return;
  if (args.action === 'check')
    return effects(live ? 'read_only' : 'none', live ? ['readiness', 'account_metadata'] : []);
  if (args.action === 'program_check')
    return effects(live ? 'read_only' : 'none', live ? ['conditional_program_observation'] : []);
  if (['capabilities', 'contracts', 'dashboard', 'operations', 'history'].includes(args.action))
    return effects('none', []);
}
const campaignPlanActions = new Set([
  'create',
  'get',
  'prepare_next',
  'execute_next',
  'verify',
  'cancel',
  'validate_provider',
  'preflight',
  'recover_step',
  'reconcile_step',
  'approve',
  'run',
  'create_from_recipe',
  'clone',
]);
const overviewReportActions = new Set(['run', 'get']);
/**
 * The website page that shows the record a first-party result names (MCP-09): an explicit table by tool and action, so
 * a link carries the ID its page loads. The generic `id` fallback sent exports, retries and cancels to the report page
 * with an export hash or a job ID, and media variants to the review page with a variant ID; both opened an error page.
 * A result whose record has no page gets no link.
 */
function handoffRecord(tool: string, action: unknown, data: JsonObject): string | undefined {
  const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 160 ? encodeURIComponent(v) : '');
  if (tool === 'amcp_campaign') {
    // A campaign plan: the page loads amcp_campaign get {id}.
    const plan = id(data.campaign_id) || (campaignPlanActions.has(String(action)) ? id(data.id) : '');
    return plan ? '/campaigns?id=' + plan : undefined;
  }
  if (tool === 'amcp_media') {
    // A media review: the page loads amcp_media recovery {review_id}. A variant is no review.
    if (action === 'variant' || data.record_kind === 'media_variant') return;
    const review = id(data.review_id);
    return review ? '/media?review_id=' + review : undefined;
  }
  if (tool === 'amcp_reporting') {
    if (['allocation_plan', 'search_exclusion_plan'].includes(data.record_kind)) {
      const plan = id(data.campaign_id) || id(data.id);
      return plan ? '/campaigns?id=' + plan : undefined;
    }
    const report = id(data.report_id) || id(data.id);
    return report ? '/reports?id=' + report : undefined;
  }
  if (tool === 'amcp_reporting_overview' && data.state) {
    // A report snapshot: the page loads amcp_reporting_overview get {id}. Exports, retries and cancels name it.
    const report = id(data.report_id) || (overviewReportActions.has(String(action)) ? id(data.id) : '');
    return report ? '/reporting-overview?report_id=' + report : undefined;
  }
}
/** A suggested call with its declared effects (MCP-09). */
export function withEffects<T extends {tool: string; arguments: JsonObject}>(call: T): T & {effects?: JsonObject} {
  const effects = callEffects(call);
  return effects ? {...call, effects} : call;
}

/** Additive metadata for first-party workflows. Native provider payloads never choose UI routes or next actions. */
export function workflowOutcome(tool: string | undefined, data: JsonObject, action?: unknown): JsonObject | undefined {
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
  if (
    tool === 'amcp_workspace' &&
    data.record_kind === 'conditional_program_check' &&
    /^program:(?:linkedin_forecast|linkedin_audience_insights|dv360_advertiser)$/.test(data.workflow_id ?? '') &&
    typeof data.scope?.connection_id === 'string' &&
    typeof data.scope?.account_id === 'string'
  ) {
    result.website_path =
      '/capabilities?workflow_id=' +
      encodeURIComponent(data.workflow_id) +
      '&connection_id=' +
      encodeURIComponent(data.scope.connection_id) +
      '&account_id=' +
      encodeURIComponent(data.scope.account_id);
    result.entitlement = 'unverified';
    result.advertising_writes = 0;
    result.automatic_retry_of_mutation = false;
  }
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
    else if (['portfolio', 'portfolio_reconciliation'].includes(data.record_kind)) result.website_path = '/portfolio';
    else if (data.record_kind === 'audit_history') result.website_path = '/activity';
    else if (data.record_kind === 'catalog_comparison') {
      const query = ['connection_id', 'account_id', 'catalog_id']
        .filter(key => typeof data.scope?.[key] === 'string' && data.scope[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(data.scope[key]))
        .join('&');
      result.website_path = '/commerce?catalog_comparison=1' + (query ? '&' + query : '');
    } else if (
      data.record_kind === 'catalog_source_inventory' &&
      data.state === 'complete' &&
      data.complete_collected_inventory === true &&
      data.scope?.gateway === 'commerce_native_action' &&
      data.scope.source_kind === 'inventory' &&
      data.scope.absent_source_policy === 'retain' &&
      data.scope.api_version === 'wc/v3' &&
      data.scope.product_status === 'publish' &&
      data.scope.variation_status === 'any' &&
      ['price', 'regular_price', 'sale_price'].includes(data.scope.price_field) &&
      ['connection_id', 'account_id'].every(
        key => typeof data.scope[key] === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.scope[key]),
      )
    ) {
      result.website_path =
        '/commerce?woo_inventory=1&connection_id=' +
        encodeURIComponent(data.scope.connection_id) +
        '&account_id=' +
        encodeURIComponent(data.scope.account_id) +
        '&price_field=' +
        data.scope.price_field;
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
          data.scope.price_field +
          (data.scope.source_kind === 'variations' && /^[1-9][0-9]{0,19}$/.test(data.scope.parent_product_id ?? '')
            ? '&source_kind=variations&parent_product_id=' + data.scope.parent_product_id
            : '');
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
    } else if (data.record_kind === 'measurement_google_goals') {
      const query = ['connection_id', 'account_id']
        .filter(key => typeof data.scope?.[key] === 'string' && data.scope[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(data.scope[key]))
        .join('&');
      result.website_path = '/measurement?google_goals=1' + (query ? '&' + query : '');
    } else if (data.record_kind === 'measurement_ga4_config') {
      // The GA4 scope names the property property_id; the website link selects it by account_id.
      const values = {connection_id: data.scope?.connection_id, account_id: data.scope?.property_id},
        query = (['connection_id', 'account_id'] as const)
          .filter(key => typeof values[key] === 'string' && values[key].length <= 200)
          .map(key => key + '=' + encodeURIComponent(values[key]))
          .join('&');
      result.website_path = '/measurement?ga4_config=1' + (query ? '&' + query : '');
    } else if (data.record_kind === 'measurement_ledger') {
      // MSR-03: the ledger link names its gateway, because one picker lists Google Ads customers and GA4 properties.
      const query = ['gateway', 'connection_id', 'account_id']
        .filter(key => typeof data.scope?.[key] === 'string' && data.scope[key].length <= 200)
        .map(key => key + '=' + encodeURIComponent(data.scope[key]))
        .join('&');
      result.website_path = '/measurement?ledger=1' + (query ? '&' + query : '');
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
  const record = handoffRecord(tool!, action, data);
  if (record) result.website_path = record;
  if (data.next_call) result.next_call = data.next_call;
  if (data.execute_requirements)
    result.required_acknowledgements = Object.keys(data.execute_requirements).filter(
      k => data.execute_requirements[k] === true,
    );
  return result;
}
