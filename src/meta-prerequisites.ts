import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {metaPrefix} from './meta-version.js';

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
        path: metaPrefix + 'act_' + plan.accountId + '/' + edge,
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
    // An image already in the ad account (CMP-06): the account's image list must return this exact hash.
    const hash = story.link_data?.image_hash;
    if (typeof hash === 'string' && !deferredPaths.some(p => p.endsWith('/image_hash'))) {
      if (!/^[A-Za-z0-9]{8,64}$/.test(hash))
        throw new MirrorError('PREFLIGHT_ID_REQUIRED', 'Use the exact image hash Meta returned for this ad account.');
      const images = (await service.runPlan(
        {
          ...plan,
          method: 'GET',
          path: metaPrefix + 'act_' + plan.accountId + '/adimages',
          body: undefined,
          query: {hashes: JSON.stringify([hash]), fields: 'hash,account_id'},
          readOnly: true,
          destructive: false,
          requiresConfirmation: false,
        },
        {connection_id: connectionId},
        actor,
      )) as JsonObject;
      const found =
        Array.isArray(images.data?.data) &&
        images.data.data.some(
          (v: JsonObject) =>
            v.hash === hash && (v.account_id === undefined || String(v.account_id) === String(plan.accountId)),
        );
      if (!found)
        throw new MirrorError(
          'CAMPAIGN_PREREQUISITE_REQUIRED',
          'The selected account did not return this image hash. Use an image uploaded to this ad account, or choose another image source.',
          {asset_type: 'Meta image', asset_id: hash, account_id: plan.accountId, missing_fields: ['image_hash']},
        );
      checks.push({asset_type: 'Meta image', asset_id: hash, status: 'provider_read_checked'});
    }
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
