import type {AdPreviewHooks} from './provider-adapter.js';

/**
 * X's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/x-adapter.ts): X has a Tweet
 * preview read, but its parameters are not pinned in AMCP's evidence, so AMCP does not call it on its own.
 */
export const xAdPreviews: AdPreviewHooks = Object.freeze({
  platform: 'x_ads',
  explain: () => ({
    preview_route: 'not_qualified',
    explanation:
      'X has a Tweet preview read (x_accounts_account_id_tweet_previews_get), but its parameters are not pinned in AMCP’s evidence, so AMCP does not call it on its own. Open the promoted Tweet on X instead.',
  }),
});
