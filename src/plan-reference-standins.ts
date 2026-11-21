import {MirrorError} from './errors.js';
import type {CampaignPreflight} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {boundedPointer, boundedStepId, obj, planReference} from './workspace-core.js';

/**
 * The stand-in request of a plan step (R2.5, package r25-field3-refs, the owner's second Google report of 2026-11-21, AMCP-01).
 *
 * A step's arguments may name the result of a step it depends on: `{$ref: "<step>#/<pointer>"}`, optionally with a LinkedIn URN prefix. The
 * result is not known until that step has run, so the plan's preflight, which checks every step's contract before anything is sent, and the
 * approval's spend effects (src/campaign-spend-effects.ts), which compile each step locally to say whether it spends, give each reference a
 * well-formed stand-in and check the step as if it held it. A stand-in used to depend only on what the predecessor makes, never on which of
 * its results was named, so 25 different new assets were one asset and every within-request duplicate check ("this asset is linked twice",
 * "each ad group may appear once", "each pair may appear only once") refused the step.
 *
 * Each distinct `<step>#<pointer>` of one step now has an ordinal of its own, 1, 2, 3 and so on in the order it is first met (arrays by index,
 * objects in key order, so the same arguments always give the same ordinals), and the provider's hook builds its placeholder from that number
 * and varies nothing else: references to different results are different identities, and two references to the SAME result stay one identity
 * and are still refused as a duplicate. Once the predecessors have run, every real ID is checked again when the step is prepared (the real
 * duplicates, the live state, the whole request), so nothing is checked less than before.
 *
 * The preflight and the spend effects call this one function, so that the approval's spend effects and the preflight judge the same request.
 * It names no provider: a provider's part is its adapter's `campaign.preflight.reference` hook, passed in.
 */
export interface StandInContext {
  /** The step the arguments belong to: its `depends_on` names the steps it may reference. */
  readonly step: JsonObject;
  /** The plan's steps, where a reference finds its predecessor. */
  readonly steps: readonly JsonObject[];
  /** The step's provider's placeholder hook (its adapter's `campaign.preflight.reference`); the generic number without one. */
  readonly reference?: CampaignPreflight['reference'];
  /** The compiler, passed in so that this module imports none. */
  readonly compile: (gateway: string, args: JsonObject) => CompiledRequest;
}

/**
 * What the refusal of a reference to a step that is not a declared predecessor says (R2.5 r25-field3-refs, AMCP-02, F2-2): the step the reference
 * names, the pointer it gave and the steps the step may reference (at most 20, with their number when there are more). Step IDs and pointers only,
 * and only in their own spelling: text of another shape in a reference, a link or a token, is never repeated (it is null).
 */
export function undeclaredReference(ref: string, declared: Iterable<unknown>): JsonObject {
  const at = ref.indexOf('#'),
    steps = [...declared].map(boundedStepId).filter((id): id is string => id !== null);
  return {
    predecessor: at < 0 ? null : boundedStepId(ref.slice(0, at)),
    ...(at < 0 ? {} : {received_pointer: boundedPointer(ref.slice(at + 1))}),
    depends_on: steps.slice(0, 20),
    ...(steps.length > 20 ? {depends_on_total: steps.length} : {}),
  };
}

/**
 * The ordinal of each distinct `<step>#<pointer>` in the arguments, from 1, in the order each is first met. Only the reference itself is
 * read: a malformed one is refused when its stand-in is made.
 */
export function referenceOrdinals(value: unknown): Map<string, number> {
  const ordinals = new Map<string, number>();
  const visit = (v: unknown): void => {
    if (obj(v) && Object.hasOwn(v, '$ref')) {
      if (typeof v.$ref === 'string' && !ordinals.has(v.$ref)) ordinals.set(v.$ref, ordinals.size + 1);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (obj(v)) Object.values(v).forEach(visit);
  };
  visit(value);
  return ordinals;
}

/**
 * The step's arguments with every reference replaced by its stand-in, and the path of each reference replaced (a path is a JSON pointer of
 * the arguments, `/payload/operations/0/create/asset`, one for each reference, repeats included). A reference that does not name a declared
 * predecessor is refused. The arguments given are not changed.
 */
export function standInArguments(
  context: StandInContext,
  args: unknown = context.step.arguments,
): {arguments: any; paths: string[]} {
  const ordinals = referenceOrdinals(args),
    paths: string[] = [],
    declared: unknown[] = context.step.depends_on ?? [];
  const walk = (v: unknown, path: string): any => {
    if (obj(v) && Object.hasOwn(v, '$ref')) {
      const {ref, prefix} = planReference(v),
        parentId = ref.split('#')[0];
      if (!ref.includes('#') || !declared.includes(parentId))
        throw new MirrorError(
          'INVALID_REFERENCE',
          'References must use a declared predecessor.',
          undeclaredReference(ref, declared),
        );
      paths.push(path);
      const ordinal = ordinals.get(ref)!;
      // A LinkedIn URN built from the referenced ID: the placeholder takes the same shape.
      if (prefix !== undefined) return prefix + String(ordinal);
      return (
        context.reference?.({
          path,
          ref,
          parent: context.steps.find(s => s.id === parentId),
          ordinal,
          compile: context.compile,
        }) ?? String(ordinal)
      );
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, path + '/' + i));
    if (obj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path + '/' + k)]));
    return v;
  };
  return {arguments: walk(args, ''), paths};
}
