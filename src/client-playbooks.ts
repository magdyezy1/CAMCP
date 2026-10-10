import {bad, fingerprint, noSecrets, obj, pointer, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {presentationStyle} from './report-packs.js';
import {MirrorError} from './errors.js';

/** Templates are deterministic substitution, never executable code or an authorization grant. */
export function expandTemplate(value: any, variables: JsonObject): any {
  if (typeof value === 'string')
    return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, key) => {
      const found = pointer(variables, '/' + key.split('.').join('/'));
      if (typeof found !== 'string' && typeof found !== 'number') bad('Template variables must be scalar.');
      return String(found);
    });
  if (Array.isArray(value)) return value.map(v => expandTemplate(v, variables));
  return obj(value)
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandTemplate(v, variables)]))
    : value;
}
/**
 * Appends a playbook's UTM parameters to a landing page (CMP-06). Existing query text and the fragment are kept byte
 * for byte; a parameter the URL already sets to the same value is kept once, and one it sets to a different value is
 * refused rather than silently rewritten. The playbook preview and recipe compilation share this, so both show the
 * same URL.
 */
export function tagLandingPage(destination: string, parameters: Record<string, string>) {
  const url = new URL(destination),
    added: string[] = [],
    applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value === '') continue;
    const present = url.searchParams.getAll(key);
    if (present.some(v => v !== value))
      throw new MirrorError(
        'PLAYBOOK_UTM_CONFLICT',
        'The landing page already sets a tracking parameter to a different value than the client playbook. Remove that parameter from the URL, or turn off playbook rules for this plan.',
        {parameter: key, url_value: present.find(v => v !== value), playbook_value: value},
      );
    applied[key] = value;
    if (!present.length) added.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  }
  const [base, ...hash] = destination.split('#'),
    separator = !added.length ? '' : !base!.includes('?') ? '?' : /[?&]$/.test(base!) ? '' : '&';
  return {
    result: base + separator + added.join('&') + (hash.length ? '#' + hash.join('#') : ''),
    parameters: applied,
  };
}
export function validatePlaybook(p: JsonObject) {
  noSecrets(p);
  if (p.report_presentation !== undefined) presentationStyle(p.report_presentation);
  for (const key of ['utm', 'defaults', 'templates', 'variables', 'conversion_mappings'])
    if (p[key] !== undefined && !obj(p[key])) bad(key + ' must be a named object.', 'INVALID_PROFILE');
  if (p.naming !== undefined && typeof p.naming !== 'string' && !obj(p.naming))
    bad('Use a naming template or named templates.', 'INVALID_PROFILE');
  for (const [key, value] of Object.entries(p.utm ?? {}))
    if (
      !['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'].includes(key) ||
      typeof value !== 'string' ||
      value.length > 2048
    )
      bad('Use supported UTM names and string templates up to 2,048 characters.', 'INVALID_PROFILE');
  if (Object.keys(p.templates ?? {}).length > 50) bad('Keep at most 50 named campaign templates.', 'INVALID_PROFILE');
  for (const steps of Object.values(p.templates ?? {}))
    if (!Array.isArray(steps) || !steps.length || steps.length > 50 || steps.some(s => !obj(s)))
      bad('Each template needs 1–50 explicit campaign steps.', 'INVALID_PROFILE');
  if (
    p.defaults?.recipes !== undefined &&
    (!obj(p.defaults.recipes) || Object.values(p.defaults.recipes).some(v => !obj(v)))
  )
    bad('Recipe defaults are objects keyed by recipe ID.', 'INVALID_PROFILE');
  // Shared defaults apply to every recipe that takes the field (CMP-06).
  if (p.defaults?.common !== undefined && !obj(p.defaults.common))
    bad('Shared defaults (defaults.common) are a named object.', 'INVALID_PROFILE');
}
export function previewPlaybook(profile: JsonObject, input: JsonObject): JsonObject {
  validate(input, ['variables', 'destination_url', 'template']);
  if (input.variables !== undefined && !obj(input.variables)) bad('Preview variables must be a named object.');
  const variables = {...(profile.variables ?? {}), ...(input.variables ?? {}), profile};
  noSecrets(variables);
  const resolved = expandTemplate({naming: profile.naming ?? '', utm: profile.utm ?? {}}, variables);
  let destination: string | null = null;
  if (input.destination_url) {
    let url: URL;
    try {
      url = new URL(input.destination_url);
    } catch {
      return bad('Use an absolute HTTPS landing page URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      bad('Use an HTTPS landing page without embedded credentials.');
    // The same tagging recipe plans apply (CMP-06), so this preview and a recipe preview show the same URL.
    destination = tagLandingPage(
      input.destination_url,
      Object.fromEntries(Object.entries(resolved.utm).map(([key, value]) => [key, String(value)])),
    ).result;
  }
  const steps = input.template ? profile.templates?.[input.template] : undefined;
  if (input.template && !steps) bad('Choose a saved template from this profile.');
  return {
    version: 1,
    profile: {id: profile.id ?? null, revision: profile.revision ?? null, name: profile.name},
    ...resolved,
    destination_url: destination,
    ...(steps ? {steps: expandTemplate(steps, variables)} : {}),
    bindings: profile.bindings ?? [],
    defaults: profile.defaults ?? {},
    conversion_mappings: profile.conversion_mappings ?? {},
    report_presentation:
      profile.report_presentation === undefined ? null : presentationStyle(profile.report_presentation),
    fingerprint: fingerprint({profile, variables, template: input.template ?? null, destination_url: destination}),
    network_requests: 0,
    meaning:
      'Preview only. Defaults are copied into a new draft; existing plans and schedules keep their recorded profile revision. Account bindings do not grant access.',
  };
}
