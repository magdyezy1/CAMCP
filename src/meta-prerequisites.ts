import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';

export async function metaPrerequisites(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  deferredPaths: string[] = [],
) {
  if (plan.gateway !== 'meta_native_action') return;
  const body = (plan.body ?? {}) as JsonObject,
    story = body.object_story_spec ?? {},
    checks: JsonObject[] = [];
  const requireAsset = async (edge: string, id: string, label: string) => {
    if (
      deferredPaths.some(p =>
        p.endsWith(
          '/' +
            ({promote_pages: 'page_id', adspixels: 'pixel_id', instagram_accounts: 'instagram_user_id'} as JsonObject)[
              edge
            ],
        ),
      )
    ) {
      checks.push({asset_type: label, status: 'dependency_pending'});
      return;
    }
    if (!/^[1-9][0-9]*$/.test(id))
      throw new MirrorError('PREFLIGHT_ID_REQUIRED', 'Use an explicit ' + label + ' identifier.');
    const result = (await service.runPlan(
      {
        ...plan,
        method: 'GET',
        path: '/v25.0/act_' + plan.accountId + '/' + edge,
        body: undefined,
        query: {fields: 'id', limit: 100},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
      },
      {connection_id: connectionId, aggregate_pages: true, max_pages: 25},
      actor,
    )) as JsonObject;
    if (result.truncated || !Array.isArray(result.data?.data) || !result.data.data.some((v: JsonObject) => v.id === id))
      throw new MirrorError(
        'CAMPAIGN_PREREQUISITE_REQUIRED',
        'The selected account did not confirm access to the requested ' +
          label +
          '. Fix this before creating the campaign hierarchy.',
        {asset_type: label, asset_id: id, account_id: plan.accountId, missing_fields: [label + ' access']},
      );
    checks.push({asset_type: label, asset_id: id, status: 'provider_read_checked'});
  };
  if (plan.path.endsWith('/adcreatives')) {
    const page = story.page_id ?? body.object_story_id?.split('_')[0];
    if (page) await requireAsset('promote_pages', page, 'Facebook Page');
    const instagram = story.instagram_user_id ?? story.instagram_actor_id ?? body.instagram_user_id;
    if (instagram) await requireAsset('instagram_accounts', instagram, 'Instagram account');
    const link = story.link_data?.link ?? story.video_data?.call_to_action?.value?.link;
    if (link) {
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS destination URL.');
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new MirrorError('DESTINATION_REQUIRED', 'Use an HTTPS destination without embedded credentials.');
      checks.push({
        asset_type: 'destination',
        status: 'syntax_checked',
        meaning: 'Provider policy and public landing-page availability still require validation.',
      });
    }
  }
  if (plan.path.endsWith('/adsets') && ['OFFSITE_CONVERSIONS', 'VALUE'].includes(body.optimization_goal)) {
    const promoted = body.promoted_object;
    if (!promoted?.pixel_id || (!promoted.custom_event_type && !promoted.custom_conversion_id))
      throw new MirrorError(
        'CONVERSION_SETUP_REQUIRED',
        'Website conversion optimization requires the actual pixel and conversion event.',
        {missing_fields: ['promoted_object.pixel_id', 'promoted_object.custom_event_type or custom_conversion_id']},
      );
    await requireAsset('adspixels', promoted.pixel_id, 'Meta pixel');
  }
  return checks;
}
