import type {JsonObject} from './types.js';
import {normalizeAccount} from './account-id.js';
import {MirrorError} from './errors.js';
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
 * when none of them is there. Only the names are repeated, never their values. The sentence is the refusal's `details.hint`,
 * beside its message and not behind it: the message stays one sentence the website can show in Arabic (R2.5 S3-3), and a
 * sentence built from the names that were given has no single form to look up.
 */
export function topLevelMoves(input: JsonObject): {hint: string; move: JsonObject[]} | undefined {
  const names = stepFields.filter(k => input[k] !== undefined);
  if (!names.length) return undefined;
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  return {
    hint:
      'Move ' +
      list +
      ' into each step (' +
      names.map(k => 'steps[].' + k).join(', ') +
      '): create does not take them at its top level.',
    move: names.map(k => ({from: k, to: 'steps[].' + k})),
  };
}

/**
 * A call or a plan step that writes its `gateway` inside its `arguments`, read as if the gateway stood beside them (R2.5 field
 * fix, call shape, the lead's decision of 2026-11-19). amcp_write takes the gateway at its top level and a plan step takes it in the
 * step, and an agent that knew one shape wrote the other: it was refused by a sentence that named neither the fault nor the fix. Only
 * when the host names no gateway of its own (a host that does is the caller's call as it stands, so an action that ever took a
 * native `gateway` argument keeps it) and `arguments.gateway` is a gateway the caller's registry knows. The gateway leaves
 * `arguments`: everything that reads the host after this (the group check, the review that is frozen, its stored prepare input and
 * each call that prepares it again) sees the canonical shape. Undefined when nothing is lifted. Nothing here names a provider:
 * `registered` is the registry of whoever calls.
 */
export function liftedGateway(host: JsonObject, registered: (gateway: string) => boolean): JsonObject | undefined {
  const args = host.arguments;
  if (host.gateway !== undefined || !obj(args) || typeof args.gateway !== 'string' || !registered(args.gateway))
    return undefined;
  const {gateway, ...rest} = args;
  return {...host, gateway, arguments: rest};
}

/**
 * What a plan step carries beside its arguments that amcp_write does not take, in the one order every refusal names them: the
 * account, which amcp_write takes inside arguments, and the four keys that only a step of amcp_campaign create has.
 */
const writeCallStepKeys = ['account_id', 'id', 'kind', 'depends_on', 'description'];

/**
 * The refusal of an amcp_write prepare or inspect that carries the keys of a plan step (R2.5 field fix, call shape, 2026-11-19): the
 * call fell to the generic refusal of an unknown parameter, which names the key and not the shape. The one sentence says what the
 * first key is and where it goes; `details` carry that key (`field`), where every such key goes (`move`: account_id inside
 * arguments, the others as a step of amcp_campaign create), a hint that says it in a sentence, and the help that shows the shape
 * (`next_call`). Only the names of keys are repeated, never their values (R2.5 S4-7: a token pasted into a field came back in a
 * refusal that is logged and audited). Undefined when the call has none of them, and for an action that takes no arguments for
 * them to move into, which keeps the generic refusal.
 */
export function misplacedStepKeys(input: JsonObject): MirrorError | undefined {
  if (input.action !== 'prepare' && input.action !== 'inspect') return undefined;
  const present = writeCallStepKeys.filter(key => Object.hasOwn(input, key)),
    planOnly = present.filter(key => key !== 'account_id');
  if (!present.length) return undefined;
  const field = planOnly[0] ?? 'account_id',
    several = planOnly.length > 1,
    names = several ? planOnly.slice(0, -1).join(', ') + ' and ' + planOnly.at(-1) : planOnly[0],
    details = {
      field,
      move: present.map(key => ({
        from: key,
        to: key === 'account_id' ? 'arguments.account_id' : 'amcp_campaign create steps[].' + key,
      })),
      hint: planOnly.length
        ? 'amcp_write prepares one change: gateway and connection_id stand beside arguments, and the account goes inside arguments. ' +
          names +
          (several ? ' are fields' : ' is a field') +
          ' of a plan step: send the step to amcp_campaign create, or leave ' +
          (several ? 'them' : 'it') +
          ' out for one change.' +
          (present.includes('account_id') ? ' Move account_id into arguments too.' : '')
        : 'amcp_write takes the account inside arguments, beside the native action and its payload: move account_id there. amcp_campaign create is the call that takes it beside arguments, in each step.',
      next_call: {tool: 'amcp_write', arguments: {action: 'help', topic: 'prepare'}},
    };
  return planOnly.length
    ? new MirrorError(
        'INVALID_ARGUMENT',
        '{field} belongs to a plan step: send it as a step to amcp_campaign create.',
        details,
        400,
        false,
        {field},
      )
    : new MirrorError('INVALID_ARGUMENT', 'account_id goes inside arguments in amcp_write.', details);
}

/** Where amcp_write takes its gateway, in the words of the warning a lifted one draws. */
export const writeGatewaySite = 'amcp_write takes at its top level, beside arguments';

/**
 * The deprecation warning of a gateway that was lifted out of `arguments` (a `meta.argument_warnings` entry, in the style of
 * src/action-aliases.ts): where the caller wrote it, where it was read as written, and where the tool takes it. The old shape keeps
 * working; a later release may refuse it.
 */
export const gatewayMovedWarning = (field: string, to: string, site: string): JsonObject => ({
  code: 'GATEWAY_PLACEMENT_DEPRECATED',
  field,
  moved_to: to,
  message:
    field +
    ' was used as ' +
    to +
    ', which ' +
    site +
    '. Send it there: a later release may refuse it with INVALID_ARGUMENT.',
});
