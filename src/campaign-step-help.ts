import type {JsonObject} from './types.js';

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

/**
 * A value that may be repeated in a refusal: a short plain identifier (a gateway, a connection or an account), never free
 * text. The response of a refusal is logged and audited, and an identifier is not a secret; arguments are never repeated.
 */
const identifier = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v) ? v : undefined;

/**
 * The corrected minimal step for the kind of a refused step: what the caller sent that is plain and right (the step's id,
 * gateway, connection and account, and a gateway, connection or account given at the top level of create, where it
 * belongs inside the step), and for everything else a placeholder. A media step has no gateway: its platform names it.
 * Its arguments are the placeholders of its kind, never the caller's.
 */
export function correctedStep(step: unknown, top: JsonObject = {}): JsonObject {
  const s = obj(step) ? step : {},
    media = s.kind === 'media';
  return {
    id: typeof s.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id) ? s.id : 'step_1',
    kind: media ? 'media' : 'write',
    ...(media ? {} : {gateway: identifier(s.gateway) ?? identifier(top.gateway) ?? '<gateway>'}),
    connection_id: identifier(s.connection_id) ?? identifier(top.connection_id) ?? '<connection_id>',
    account_id: identifier(s.account_id) ?? identifier(top.account_id) ?? '<account_id>',
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
