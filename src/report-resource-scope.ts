import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

function unavailable(): never {
  throw new MirrorError(
    'REPORT_SCOPE_UNAVAILABLE',
    'The retained reporting resource selector is invalid or cannot establish an exact account. Inspect the original definition and prepare a corrected read-only run.',
    {},
    403,
  );
}

/** Native selectors from the existing delegated compiler. Return only the exact account, never the child path. */
export function reportingResourceAccount(gateway: string, row: JsonObject): string {
  const value: unknown = row?.value;
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20\\]/.test(value)) unavailable();
  if (gateway === 'ga4_native_action') {
    if (row.kind === 'property') {
      const match = /^(?:properties\/)?([0-9]{1,32})$/.exec(value);
      return match?.[1] ?? unavailable();
    }
    if (row.kind === 'resource') {
      // Discovery uses properties/{property}/... resource names. ScopeGuard derives the same exact parent.
      const match = /^properties\/([0-9]{1,32})(?:\/[^/\x00-\x20\\?#%]+)*$/.exec(value);
      if (!match || value.split('/').some(part => part === '.' || part === '..')) unavailable();
      return match[1]!;
    }
  }
  if (gateway === 'google_search_console_native_action' && row.kind === 'site') {
    if (value.length > 200) unavailable();
    if (/^sc-domain:[^/?#]+$/.test(value)) return value;
    if (/^https?:\/\//.test(value)) {
      try {
        const url = new URL(value);
        if (!url.username && !url.password) return value; // Preserve prefix-property bytes, including trailing slash.
      } catch {}
    }
  }
  if (['gtm_native_action', 'google_business_native_action'].includes(gateway)) {
    const id = '[A-Za-z0-9_-]{1,200}';
    if (row.kind === 'account') {
      if (gateway === 'google_business_native_action' && new RegExp('^locations/' + id + '$').test(value)) return value;
      const match = new RegExp('^(?:accounts/)?(' + id + ')$').exec(value);
      return match?.[1] ?? unavailable();
    }
    if (gateway === 'google_business_native_action' && row.kind === 'location') {
      const match = new RegExp('^(?:locations/)?(' + id + ')$').exec(value);
      return match ? 'locations/' + match[1] : unavailable();
    }
    if (row.kind === 'resource') {
      if (value.split('/').some(part => part === '.' || part === '..')) unavailable();
      const account = new RegExp('^accounts/(' + id + ')(?:/[^/\\x00-\\x20\\\\?#%]+)*$').exec(value);
      if (account) return account[1]!;
      if (gateway === 'google_business_native_action') {
        const location = new RegExp('^locations/(' + id + ')(?:/[^/\\x00-\\x20\\\\?#%]+)*$').exec(value);
        if (location) return 'locations/' + location[1];
      }
    }
  }
  return unavailable();
}

/** Business Profile's location is a child consistency check when an account parent is present.
 * A bare location selector can establish locations/{id} only when no existing account context is supplied.
 */
export function reportingResourceAccounts(gateway: string, rows: JsonObject[], existingAccounts: unknown[]): string[] {
  if (gateway !== 'google_business_native_action') return rows.map(row => reportingResourceAccount(gateway, row));
  const locationRows = rows.filter(row => row.kind === 'location'),
    otherRows = rows.filter(row => row.kind !== 'location'),
    accounts = otherRows.map(row => reportingResourceAccount(gateway, row)),
    locations = locationRows.map(row => reportingResourceAccount(gateway, row));
  if (locations.length) {
    const referenced = [
      ...accounts.filter(account => account.startsWith('locations/')),
      ...existingAccounts.filter(account => typeof account === 'string' && account.startsWith('locations/')),
      ...otherRows
        .filter(row => row.kind === 'resource')
        .flatMap(row => {
          const match = /(?:^|\/)locations\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(row.value);
          return match ? ['locations/' + match[1]] : [];
        }),
    ];
    if (new Set([...locations, ...referenced]).size > 1) unavailable();
  }
  return accounts.length || existingAccounts.length ? accounts : locations;
}

/** SQLite projects at most nine native scope selectors from a bounded argument object.
 * json_tree preserves repeated keys; the compiler's alias comparison is shared through a pure SQLite function.
 * Complete definitions, unrelated body fields and native child resources never leave the metadata endpoint.
 */
export function reportResourceFieldsSQL(native: string) {
  const source = "CASE WHEN length(CAST(j.input AS BLOB))<=131072 THEN j.input ELSE '{}' END",
    config = `json_extract(${source},'$.query_config')`,
    wrapper = `json_extract(${source},'$.query_config.arguments')`,
    occurrences = (cell: string, key: string) => `(SELECT count(*) FROM json_each(${cell}) WHERE key='${key}')`,
    wrapped = "json_type(j.input,'$.query_config.arguments.operation')='text'",
    envelopeValid = `length(CAST(j.input AS BLOB))<=131072
      AND ${occurrences(source, 'query_config')}=1 AND json_type(${source},'$.query_config')='object'
      AND ${occurrences(config, 'gateway')}=1 AND ${occurrences(config, 'arguments')}=1
      AND CASE WHEN ${wrapped} THEN ${occurrences(wrapper, 'operation')}=1 AND ${occurrences(wrapper, 'arguments')}=1 ELSE 1 END`,
    args = `CASE WHEN ${wrapped} THEN json_extract(j.input,'$.query_config.arguments.arguments')
      ELSE json_extract(j.input,'$.query_config.arguments') END`,
    argsType = `CASE WHEN ${wrapped} THEN json_type(j.input,'$.query_config.arguments.arguments')
      ELSE json_type(j.input,'$.query_config.arguments') END`,
    valid = `${envelopeValid} AND ${argsType}='object' AND length(CAST(${args} AS BLOB))<=65536`,
    bounded = `CASE WHEN ${valid} THEN ${args} ELSE '{}' END`,
    key = 'native_parameter_key(r.key)',
    direct = `r.path IN ('$','$.params','$."path_params"')`,
    ga4 = `(${direct} AND ${key} IN ('property','name','parent'))
      OR (r.path IN ('$','$.params') AND ${key} IN ('reporttaskname','audienceexportname')
        AND (r.type!='text' OR instr(r.value,'/')>0))
      OR ((r.path='$.request' OR substr(r.path,1,10) IN ('$.request.','$.request[')) AND ${key}='property')`,
    gsc = `r.path IN ('$','$.params','$."path_params"','$.payload') AND ${key} IN ('siteurl','site','propertyurl')`,
    gtm = `${direct} AND ${key} IN ('path','parent','accountid')`,
    business = `${direct} AND ${key} IN ('name','parent','accountid','locationid')`,
    project = (where: string, kind: string) => `(SELECT json_group_array(json_object('kind',v.kind,'value',
      CASE WHEN v.type='text' THEN substr(v.value,1,513) ELSE json('{"invalid":true}') END))
      FROM (SELECT r.type,r.value,${kind} AS kind FROM json_tree(${bounded}) r WHERE ${where} LIMIT 9) v)`,
    invalidBody = (body: string) => `EXISTS(SELECT 1 FROM json_tree(${bounded}) r
      WHERE r.path='$' AND r.key='${body}' AND r.type!='object')`;
  return `'resource_account_anchors',CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')
      WHEN 'ga4_native_action' THEN json_array(${project(ga4, `CASE WHEN ${key}='property' THEN 'property' ELSE 'resource' END`)})
      WHEN 'google_search_console_native_action' THEN json_array(${project(gsc, "'site'")})
      WHEN 'gtm_native_action' THEN json_array(${project(gtm, `CASE WHEN ${key}='accountid' THEN 'account' ELSE 'resource' END`)})
      WHEN 'google_business_native_action' THEN json_array(${project(business, `CASE ${key} WHEN 'accountid' THEN 'account' WHEN 'locationid' THEN 'location' ELSE 'resource' END`)})
      ELSE json_array() END ELSE json_array() END,
    'resource_body_invalid',CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')
      WHEN 'ga4_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('request')} THEN 1 ELSE 0 END
      WHEN 'google_search_console_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('payload')} THEN 1 ELSE 0 END
      WHEN 'gtm_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('payload')} THEN 1 ELSE 0 END
      WHEN 'google_business_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('payload')} THEN 1 ELSE 0 END
      ELSE 0 END ELSE 0 END`;
}
