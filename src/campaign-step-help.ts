import type {JsonObject} from './types.js';
import {normalizeAccount} from './account-id.js';
import {providerOf} from './provider-adapters.js';

/**
 * What an agent needs to write the steps of an amcp_campaign plan (R2.5 T4, owner General 3, 2026-11-15). The shape of a
 * step was learned only by failing: the input schema says `steps` is an array of objects (tools/list keeps no room for
 * more), and the shape stood in the text of the refusal of an invalid step. A refused step is now answered with its own
 * correction, and amcp_campaign help create carries a worked example. Nothing here names a provider: what a step sends
 * is the provider's, so the parts an example cannot know are placeholders in angle brackets.
 */
const obj = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);

/** The shape of a step in one sentence, as the refusal of an invalid step has always ended (src/campaign-runner.ts). */
export const stepShape =
  '. Each step is {"id","kind":"write","gateway","connection_id","account_id","arguments":{"action","payload"},"depends_on":[earlier ids]}; later steps use results as {"$ref":"<step id>#/data/<JSON pointer>"}.';

/** The note of the steps argument in the help of create: the shape of a step, and where its worked example is. */
export const stepsNote =
  'create: 1–50 explicit steps, in order' +
  stepShape +
  ' A media step has no gateway: its arguments are the amcp_media prepare inputs and its platform names the gateway. help create returns a worked example (worked_example).';

/** The call that returns the worked example: where every refusal of create that a caller can correct points. */
export const createHelpCall = {tool: 'amcp_campaign', arguments: {action: 'help', topic: 'create'}};

/**
 * A worked example of a plan for amcp_campaign help create: a campaign, then an ad group that waits for it and takes its
 * new ID from its verified result. It names no provider, because a step sends what its provider documents (shared help may
 * name none): the parts only a workspace can know are placeholders in angle brackets, each declared with what it stands for.
 * With every placeholder given its real value it is a plan create accepts (tests/campaign-step-help.test.mjs runs it).
 */
export const planExample: JsonObject = {
  tool: 'amcp_campaign',
  arguments: {
    action: 'create',
    // Not a string the Arabic catalogue holds: a literal of src/ that is one reads as a server message to localize
    // (tools/locale-chunks.mjs), which moves it between chunks of web/locales/ar.
    name: 'Autumn launch',
    steps: [
      {
        id: 'campaign',
        kind: 'write',
        gateway: '<gateway>',
        connection_id: '<connection_id>',
        account_id: '<account_id>',
        description: 'Create the paused campaign',
        arguments: {action: '<campaign create action>', payload: {name: '<campaign name>'}},
      },
      {
        id: 'ad_group',
        kind: 'write',
        gateway: '<gateway>',
        connection_id: '<connection_id>',
        account_id: '<account_id>',
        description: 'Create the paused ad group under the new campaign',
        depends_on: ['campaign'],
        arguments: {
          action: '<ad group create action>',
          payload: {campaign_id: {$ref: 'campaign#/data/id'}, name: '<ad group name>'},
        },
      },
    ],
  },
  placeholders: {
    '<gateway>': 'The native gateway of the account; amcp_tool_help without arguments lists them.',
    '<connection_id>':
      'The connection that holds the login of that account; amcp_workspace capabilities lists it beside the account.',
    '<account_id>': 'The account the step writes to, written the way its gateway takes it.',
    '<campaign create action>':
      'The native action that creates a campaign; amcp_tool_help with the gateway lists its actions.',
    '<ad group create action>': 'The native action that creates an ad group, ad set or ad squad of that gateway.',
    '<campaign name>': 'The name of the campaign, in the native field its create action takes.',
    '<ad group name>': 'The name of the ad group, in the native field its create action takes.',
  },
  notes: [
    'A step is a native write (kind "write": the gateway, connection_id and account_id of the account, and the native tool input in arguments) or a media upload (kind "media": no gateway, the amcp_media prepare inputs in arguments).',
    'depends_on lists the ids of earlier steps. A later step takes a value from one of them as {"$ref":"<step id>#/data/<JSON pointer>"}: the pointer reads that step’s verified result, where data is the provider’s response (get with step_id shows it), so the pointer to a new ID is where that provider puts it.',
    'brief is optional and defaults to name. gateway and account_id belong inside each step, not at the top level of create.',
    'create saves a draft plan and sends nothing to a provider: each step is its own reviewed write once the plan is approved (approve, then run; or prepare_next and execute_next one step at a time).',
  ],
};

/**
 * A value that may be repeated in a refusal has the shape of what its field holds, never just the look of a plain word
 * (R2.5 S4-7: a 40-character hex token pasted into connection_id was a plain identifier, and came back in the refusal,
 * which is logged and audited). A gateway is one the workspace's providers register, a connection is a UUID, and an
 * account has its provider's form: its own normalization of it, a short identifier that is no long run of hex digits (the
 * shape of a token). Anything else is a placeholder. Arguments are never repeated.
 */
const connectionShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  accountShape = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/;
const gatewayOf = (v: unknown): string | undefined => (typeof v === 'string' && providerOf(v) ? v : undefined);
const connectionOf = (v: unknown): string | undefined =>
  typeof v === 'string' && connectionShape.test(v) ? v : undefined;
const accountOf = (gateway: string | undefined, v: unknown): string | undefined => {
  if (typeof v !== 'string' || !accountShape.test(v)) return undefined;
  const form = gateway ? normalizeAccount(gateway, v) : v;
  return accountShape.test(form) && !/^[0-9a-f]{32,}$/i.test(form) ? v : undefined;
};

/**
 * The corrected minimal step for the kind of a refused step: what the caller sent that has the shape of its field (the
 * step's id, a registered gateway, a connection that is a UUID and an account of its provider's form, and the same given
 * at the top level of create, where each belongs inside the step), and for everything else a placeholder. A media step has
 * no gateway: its platform names it. Its arguments are the placeholders of its kind, never the caller's.
 */
export function correctedStep(step: unknown, top: JsonObject = {}): JsonObject {
  const s = obj(step) ? step : {},
    media = s.kind === 'media',
    gateway = gatewayOf(s.gateway) ?? gatewayOf(top.gateway);
  return {
    id: typeof s.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id) ? s.id : 'step_1',
    kind: media ? 'media' : 'write',
    ...(media ? {} : {gateway: gateway ?? '<gateway>'}),
    connection_id: connectionOf(s.connection_id) ?? connectionOf(top.connection_id) ?? '<connection_id>',
    account_id: accountOf(gateway, s.account_id) ?? accountOf(gateway, top.account_id) ?? '<account_id>',
    arguments: media
      ? {platform: '<platform>', source_url: '<https link to the file>'}
      : {action: '<native action>', payload: {}},
  };
}

/** What create takes inside each step and not at its own top level. */
const stepFields = ['gateway', 'account_id', 'connection_id'];
/**
 * The fields a caller put at the top level of create that belong inside each step (the White Friday mistake: gateway and
 * account_id beside the name, the steps without them), with the sentence that says so and where each one goes; undefined
 * when none of them is there. Only the names are repeated, never their values.
 */
export function topLevelMoves(input: JsonObject): {message: string; move: JsonObject[]} | undefined {
  const names = stepFields.filter(k => input[k] !== undefined);
  if (!names.length) return undefined;
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  return {
    message:
      'Move ' +
      list +
      ' into each step (' +
      names.map(k => 'steps[].' + k).join(', ') +
      '): create does not take them at its top level.',
    move: names.map(k => ({from: k, to: 'steps[].' + k})),
  };
}
