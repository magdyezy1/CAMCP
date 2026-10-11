import type {Credentials} from './types.js';

/**
 * Deployment app credentials at use time (SEC-07 S2).
 *
 * A login used to carry a copy of the deployment's OAuth client secret, developer token and Apple signing key, so
 * rotating one of them in the environment left the old value in every login and broke their renewal. A login now keeps
 * its own tokens and the client ID it was authorized with; the secrets of that client are read from the environment
 * whenever the login is used, as long as the environment still names the same client ID. A login of a different (older)
 * client keeps the copies it holds, which are then the only ones, and its health says the client changed.
 *
 * `AMCP_APP_SECRETS=copy` is the rollback lever: logins written from then on carry the copies again (a release from
 * before this change needs them). The default, `reference`, leaves them out.
 */

/** The environment-variable stem of each website platform's OAuth app (server/platform-oauth.ts `env`; a test keeps
 * the two equal). */
export const appEnvironmentStems: Readonly<Record<string, string>> = Object.freeze({
  google_sheets_native_action: 'SHEETS',
  google_drive_native_action: 'DRIVE',
  microsoft_ads_native_action: 'MICROSOFT',
  google_ads_native_action: 'GOOGLE',
  meta_native_action: 'META',
  tiktok_native_action: 'TIKTOK',
  snapchat_native_action: 'SNAPCHAT',
  linkedin_native_action: 'LINKEDIN',
  x_ads_native_action: 'X',
  ga4_native_action: 'GA4',
  gtm_native_action: 'GTM',
  google_search_console_native_action: 'GSC',
  apple_ads_native_action: 'APPLE',
  dv360_native_action: 'DV360',
  reddit_native_action: 'REDDIT',
  google_business_native_action: 'GBP',
});
/**
 * Whether the owner declared that Google approved this deployment's Cloud project for the Business Profile APIs
 * (CON-06). Without it, and without a dedicated AMCP_GBP_CLIENT_ID/SECRET, Business Profile is not offered for connection.
 */
export const businessProfileApproved = (env: NodeJS.ProcessEnv) => env.AMCP_GBP_API_APPROVED === 'true';
/**
 * Google surfaces that share AMCP_GOOGLE_CLIENT_ID/SECRET while both of their own variables are unset. Business Profile
 * (GBP) shares it only once its API approval is declared (CON-06), so the connect flow and a saved login's use-time
 * secrets resolve the same client.
 */
const sharedGoogleStems = ['GA4', 'GTM', 'GSC', 'DRIVE', 'SHEETS', 'DV360', 'GBP'];
/** Fields a login may hold that belong to the deployment, not to the person who authorized it. */
export const appSecretFields = [
  'clientSecret',
  'consumerSecret',
  'developerToken',
  'loginCustomerId',
  'appleTeamId',
  'appleKeyId',
  'applePrivateKey',
] as const satisfies readonly (keyof Credentials)[];

/** A platform's OAuth client in the environment, by its stem (`AMCP_<STEM>_CLIENT_ID` and `_CLIENT_SECRET`). */
export function appClient(stem: string, env: NodeJS.ProcessEnv): {clientId?: string; clientSecret?: string} {
  const shared =
    sharedGoogleStems.includes(stem) &&
    (stem !== 'GBP' || businessProfileApproved(env)) &&
    !env['AMCP_' + stem + '_CLIENT_ID'] &&
    !env['AMCP_' + stem + '_CLIENT_SECRET'];
  const name = shared ? 'GOOGLE' : stem;
  return {
    clientId: env['AMCP_' + name + '_CLIENT_ID'] || undefined,
    clientSecret: env['AMCP_' + name + '_CLIENT_SECRET'] || undefined,
  };
}

/** The client ID and the secrets this deployment supplies for a gateway's logins, or undefined when it names none. */
export function deploymentAppSecrets(
  gateway: string,
  env: NodeJS.ProcessEnv,
): {clientId: string; secrets: Partial<Credentials>} | undefined {
  const stem = appEnvironmentStems[gateway];
  if (!stem) return;
  const {clientId, clientSecret} = appClient(stem, env);
  if (!clientId) return;
  const secrets: Partial<Credentials> = {},
    set = (field: (typeof appSecretFields)[number], value: string | undefined) => {
      if (value) secrets[field] = value;
    };
  set(gateway === 'x_ads_native_action' ? 'consumerSecret' : 'clientSecret', clientSecret);
  if (gateway === 'google_ads_native_action') set('loginCustomerId', env.AMCP_GOOGLE_LOGIN_CUSTOMER_ID);
  if (gateway === 'microsoft_ads_native_action') set('developerToken', env.AMCP_MICROSOFT_DEVELOPER_TOKEN);
  if (gateway === 'apple_ads_native_action') {
    set('appleTeamId', env.AMCP_APPLE_TEAM_ID);
    set('appleKeyId', env.AMCP_APPLE_KEY_ID);
    set('applePrivateKey', env.AMCP_APPLE_PRIVATE_KEY);
  }
  return {clientId, secrets};
}

/** The client a login was authorized with: an OAuth 1.0a login (X) names it as its consumer key. */
export const recordedClient = (gateway: string, c: Credentials) =>
  (gateway === 'x_ads_native_action' ? (c.consumerKey ?? c.clientId) : c.clientId) || undefined;

/**
 * Whether the deployment's client for this gateway differs from the one the login was authorized with. False when
 * either is unknown (no environment, no client configured, or a login without a recorded client).
 */
export function appClientChanged(gateway: string, c: Credentials, env: NodeJS.ProcessEnv | undefined): boolean {
  const app = env && deploymentAppSecrets(gateway, env),
    recorded = recordedClient(gateway, c);
  return !!app && !!recorded && recorded !== app.clientId;
}

/**
 * The credentials a login is used with: the stored ones, with the deployment's current secrets of the same client in
 * place of any copy. A login of another client, or a deployment that names none, uses what is stored.
 */
export function withAppSecrets(gateway: string, stored: Credentials, env: NodeJS.ProcessEnv | undefined): Credentials {
  const app = env && deploymentAppSecrets(gateway, env);
  if (!app || recordedClient(gateway, stored) !== app.clientId) return stored;
  return {...stored, ...app.secrets};
}

/** `AMCP_APP_SECRETS`: `copy` keeps writing copies into logins (the rollback lever); anything else is `reference`. */
export const appSecretStorage = (env: NodeJS.ProcessEnv | undefined): 'copy' | 'reference' =>
  env?.AMCP_APP_SECRETS?.trim().toLowerCase() === 'copy' ? 'copy' : 'reference';

/**
 * What is sealed for a login. In `reference` mode, the secrets the deployment supplies for the login's own client are
 * left out (Google's developer token, no longer sent, always is), so a rotation in the environment applies to every
 * login at once. A login of another client keeps its copies: they are the only ones. In `copy` mode the deployment's
 * current secrets are written in, as before this change.
 */
export function storableCredentials(
  gateway: string,
  value: Credentials,
  env: NodeJS.ProcessEnv | undefined,
): Credentials {
  const app = env && deploymentAppSecrets(gateway, env);
  if (!app || recordedClient(gateway, value) !== app.clientId) return value;
  if (appSecretStorage(env) === 'copy') return {...value, ...app.secrets};
  const out: Credentials = {...value};
  for (const field of Object.keys(app.secrets) as (keyof Credentials)[]) delete out[field];
  if (gateway === 'google_ads_native_action') delete out.developerToken;
  return out;
}
