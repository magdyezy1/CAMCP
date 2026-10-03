import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {snapAdCreativePaths} from './snapchat-ad-creatives.js';
import {fingerprint} from './workspace-core.js';
import {validateState} from './write-state.js';

/** Read existing creative dependencies before creating any campaign predecessors. */
export async function snapAdPrerequisites(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  deferredPaths: string[],
): Promise<JsonObject[]> {
  const rows = (plan.body as JsonObject | undefined)?.ads;
  if (
    plan.gateway !== 'snapchat_native_action' ||
    plan.method !== 'POST' ||
    !plan.path.endsWith('/ads') ||
    !Array.isArray(rows)
  )
    return [];
  const fixed = rows.filter((_: unknown, i: number) => !deferredPaths.includes('/payload/ads/' + i + '/creative_id'));
  if (!fixed.length) return [];
  const paths = snapAdCreativePaths({...plan, body: {ads: fixed}}),
    wanted = paths.map(path => path.split('/').at(-1)!),
    scope = {account_id: plan.accountId, connection_id: connectionId},
    listing = await service.call(
      'snapchat_native_action',
      {
        action: 'snapchat_creative_list',
        ...scope,
        result_ids: wanted,
        aggregate_pages: true,
        max_pages: 25,
        result_fields: ['id', 'ad_account_id'],
      },
      actor,
    );
  if (!listing.success) throw new MirrorError(listing.error.code, listing.error.message, listing.error.details);
  const d = listing.data;
  if (d.truncated || !Array.isArray(d.data?.creatives))
    throw new MirrorError('INCOMPLETE_STATE', 'The selected account creative collection must be complete.');
  const owned = d.data.creatives.map((r: JsonObject) => r?.creative ?? r);
  if (
    owned.some((r: JsonObject) => r.ad_account_id !== plan.accountId) ||
    new Set(owned.map((r: JsonObject) => r.id)).size !== owned.length
  )
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Creative ownership must exactly match the selected Snapchat account.',
    );
  if (wanted.some(id => !owned.some((r: JsonObject) => r.id === id)))
    throw new MirrorError(
      'RESOURCE_SCOPE_REQUIRED',
      'The selected account did not list every existing ad creative. Inspect its creative collection before review.',
      {
        next_call: {
          tool: 'snapchat_native_action',
          arguments: {
            action: 'snapchat_creative_list',
            ...scope,
            result_ids: wanted,
            aggregate_pages: true,
            max_pages: 25,
          },
        },
      },
    );
  const assets: JsonObject[] = [];
  for (const path of paths) {
    const read: CompiledRequest = {
      ...plan,
      action: 'AMCP_PREFLIGHT_CREATIVE',
      method: 'GET',
      path,
      query: {},
      headers: {},
      body: undefined,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
    };
    const out = (await service.runPlan(read, {connection_id: connectionId}, actor)) as JsonObject;
    if (out.truncated) throw new MirrorError('INCOMPLETE_STATE', 'The existing creative read must be complete.');
    validateState(read, {status: out.status ?? 200, headers: out.headers ?? {}, data: out.data});
    const creative = out.data.creatives[0].creative ?? out.data.creatives[0],
      website = fixed.some((r: JsonObject) => r.creative_id === creative.id && r.type === 'REMOTE_WEBPAGE');
    if (website && creative.type !== 'WEB_VIEW')
      throw new MirrorError(
        'CAMPAIGN_PREREQUISITE_REQUIRED',
        'A Snapchat website ad requires an existing WEB_VIEW creative.',
        {asset_type: 'Snapchat creative', asset_id: creative.id},
      );
    let destination: string | undefined;
    if (website) {
      try {
        const url = new URL(creative.web_view_properties?.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid destination');
        destination = creative.web_view_properties.url;
      } catch {
        throw new MirrorError(
          'DESTINATION_REQUIRED',
          'Inspect an existing website creative with a full HTTPS destination without credentials.',
        );
      }
    }
    assets.push({
      asset_type: 'Snapchat creative',
      asset_id: creative.id,
      status: 'provider_read_checked',
      account_id: plan.accountId,
      connection_id: connectionId,
      creative_type: creative.type,
      ...(typeof creative.review_status === 'string' ? {review_status: creative.review_status} : {}),
      ...(destination ? {original_destination: destination, destination_status: 'syntax_checked'} : {}),
      source_reference: {
        source_kind: 'native_account_owned_creative_read',
        request: {method: 'GET', path},
        response_hash: fingerprint(out.data),
        captured_at: Date.now(),
      },
      meaning:
        'Current account ownership and creative fields were read. Approval, landing-page availability and objective acceptance remain unverified. Native review reads this creative again.',
    });
  }
  return assets;
}
