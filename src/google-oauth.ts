import type {OAuthSteps} from './provider-login.js';

/**
 * Google's OAuth flow steps (ARC-01 phase B), which the website login steps of every Google platform share (Sheets,
 * Drive, Google Ads, GA4, Tag Manager, Search Console, DV360 and Business Profile all authorize with Google's OAuth 2.0
 * endpoints, by default with the shared Google client): Google is asked for offline access and consent, and a renewal of
 * a saved login also lets the person choose the Google account.
 */
export const googleOAuth: OAuthSteps = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  authorizeParameters(parameters: URLSearchParams, {reauthorization}: {reauthorization: boolean}) {
    parameters.set('access_type', 'offline');
    parameters.set('prompt', reauthorization ? 'consent select_account' : 'consent');
  },
});
