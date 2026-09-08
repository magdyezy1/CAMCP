# Meta: campaign, ad set, creative, ad

Use `meta_native_action`. Resolve its current actions with LIST_ACTIONS / DESCRIBE_ACTION; current aliases include `meta_campaign_create`, `meta_adset_create`, `meta_creative_create`, `meta_ad_create`, `meta_image_upload` and `meta_video_upload`.

Campaign → ad set → ad; the ad references a separately reusable creative. Native account paths have an `act_` prefix. AMCP accepts either numeric or prefixed account input. New campaign/ad set/ad writes require `status: PAUSED`; this is an AMCP contract, not a claim that Meta always overrides active input.

For new link creatives, supply `object_story_spec.page_id` and `object_story_spec.link_data.link`, then the returned image hash or video ID. Discover a real Page through the selected login. An empty Page list is not permission to invent an ID. Ad-account access and Page/Instagram access are distinct.

Existing Facebook post: `object_story_id: pageId_postId`. Existing Instagram post/Reel: `source_instagram_media_id` plus `instagram_user_id`; resolve the actual media through the authorized Instagram account first. AMCP now accepts this separate identity mode without forcing a new Facebook story. Do not combine identity modes. Provider eligibility and placements remain subject to live validation.

For video stories, inspect the existing creative/thumbnail data and supply the required thumbnail in the correct video-data fields. A video ID is not an image hash. Never put a Drive sharing URL into an image-hash field. Use the server media workflow first.

Inspect currency before expressing budgets in native minor units; account currency can have different decimal conventions. Determine whether the budget belongs to the campaign or the ad set. Preserve objective, optimization, billing event, conversion location and promoted-object compatibility. Do not silently replace an immutable campaign objective with a new campaign.

The live WhatHead generic Meta `compile_entity_payload` probe returned `META_USE_NATIVE_TOOLS` on 2026-09-08. Use the native flow above. A historical manual describing generic form compilation is not current acceptance evidence.

Primary field reference: [Meta's maintained SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).
