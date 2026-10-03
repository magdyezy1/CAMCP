import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {snapAdCreativePaths, snapAdCreativePrerequisites, snapAdLeadFormFollowUps} from './snapchat-ad-creatives.js';
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
    scope = {account_id: plan.accountId, connection_id: connectionId};
  const listOwned = async (kind: 'creatives' | 'lead_generation_forms', ids: string[]) => {
    const listing = await service.call(
      'snapchat_native_action',
      {
        action: kind === 'creatives' ? 'snapchat_creative_list' : 'snapchat_lead_generation_forms_list',
        ...scope,
        result_ids: ids,
        aggregate_pages: true,
        max_pages: 25,
        result_fields: ['id', 'ad_account_id'],
      },
      actor,
    );
    if (!listing.success) throw new MirrorError(listing.error.code, listing.error.message, listing.error.details);
    const d = listing.data;
    if (d.truncated || !Array.isArray(d.data?.[kind]))
      throw new MirrorError('INCOMPLETE_STATE', 'The selected account dependency collection must be complete.');
    const singular = kind.slice(0, -1),
      owned = d.data[kind].map((r: JsonObject) => r?.[singular] ?? r);
    if (
      owned.some((r: JsonObject) => r.ad_account_id !== plan.accountId) ||
      new Set(owned.map((r: JsonObject) => r.id)).size !== owned.length
    )
      throw new MirrorError(
        'ACCOUNT_SCOPE_MISMATCH',
        'Dependency ownership must exactly match the selected Snapchat account.',
      );
    if (ids.some(id => !owned.some((r: JsonObject) => r.id === id)))
      throw new MirrorError(
        'RESOURCE_SCOPE_REQUIRED',
        'The selected account did not list every existing dependency. Inspect its account collection before review.',
        {
          next_call: {
            tool: 'snapchat_native_action',
            arguments: {
              action: kind === 'creatives' ? 'snapchat_creative_list' : 'snapchat_lead_generation_forms_list',
              ...scope,
              result_ids: ids,
              aggregate_pages: true,
              max_pages: 25,
            },
          },
        },
      );
  };
  await listOwned('creatives', wanted);
  const assets: JsonObject[] = [];
  const formReads: CompiledRequest[] = [],
    states: unknown[] = [];
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
    states.push(out.data);
    const creative = out.data.creatives[0].creative ?? out.data.creatives[0],
      website = fixed.some((r: JsonObject) => r.creative_id === creative.id && r.type === 'REMOTE_WEBPAGE'),
      leads = fixed.some((r: JsonObject) => r.creative_id === creative.id && r.type === 'LEAD_GENERATION');
    if (leads && creative.type !== 'LEAD_GENERATION')
      throw new MirrorError(
        'CAMPAIGN_PREREQUISITE_REQUIRED',
        'A Snapchat lead ad requires an existing LEAD_GENERATION creative.',
      );
    if (leads)
      for (const more of snapAdLeadFormFollowUps({...plan, body: {ads: fixed}}, read, out.data))
        if (!formReads.some(r => r.path === more.path)) formReads.push(more);
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
      ...(leads ? {lead_generation_form_id: creative.lead_generation_form_id} : {}),
      ...(typeof creative.review_status === 'string' ? {review_status: creative.review_status} : {}),
      ...(destination ? {original_destination: destination, destination_status: 'syntax_checked'} : {}),
      source_reference: {
        source_kind: 'native_account_owned_creative_read',
        request: {method: 'GET', path},
        response_hash: fingerprint(out.data),
        captured_at: Date.now(),
      },
      meaning: leads
        ? 'Current account ownership and the existing lead creative reference were read. Provider approval and objective acceptance remain unverified. Native review reads the creative and attached form again.'
        : 'Current account ownership and creative fields were read. Approval, landing-page availability and objective acceptance remain unverified. Native review reads this creative again.',
    });
  }
  if (formReads.length) {
    await listOwned(
      'lead_generation_forms',
      formReads.map(r => r.path.split('/').at(-1)!),
    );
    for (const read of formReads) {
      const out = (await service.runPlan(read, {connection_id: connectionId}, actor)) as JsonObject;
      if (out.truncated) throw new MirrorError('INCOMPLETE_STATE', 'The existing lead form read must be complete.');
      validateState(read, {status: out.status ?? 200, headers: out.headers ?? {}, data: out.data});
      states.push(out.data);
      const form = out.data.lead_generation_forms[0].lead_generation_form ?? out.data.lead_generation_forms[0];
      assets.push({
        asset_type: 'Snapchat lead form',
        asset_id: form.id,
        status: 'provider_read_checked',
        account_id: plan.accountId,
        connection_id: connectionId,
        ...(typeof form.title === 'string' ? {original_title: form.title} : {}),
        ...(typeof form.privacy_policy_url === 'string' ? {original_privacy_policy_url: form.privacy_policy_url} : {}),
        question_fields_count: Array.isArray(form.form_fields) ? form.form_fields.length : null,
        source_reference: {
          source_kind: 'native_account_owned_lead_form_read',
          request: {method: 'GET', path: read.path},
          response_hash: fingerprint(out.data),
          captured_at: Date.now(),
        },
        meaning:
          'The exact account-owned form definition was read without submitted leads. Privacy-policy availability, consent acceptance and provider eligibility remain unverified. Native review freezes this definition and reads it again before dispatch.',
      });
    }
  }
  snapAdCreativePrerequisites({...plan, body: {ads: fixed}}, states);
  return assets;
}
