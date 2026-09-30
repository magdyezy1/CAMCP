import {createHash} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Personal data in advertising writes, under the policy the owner approved on 2026-09-30
 * (docs/review/PERSONAL-DATA-POLICY.md). The people of an upload arrive as `people` beside the reviewed request, never
 * inside its arguments. They are normalized and hashed with SHA-256 here, in memory, while the request is built. A
 * review keeps only their counts and one digest of the sorted hashed batch; at execution the same people are sent
 * again, hashed again and must give the same digest. Nothing about them reaches the database, the audit trail,
 * receipts, verification records or error details.
 *
 * Only the workspace owner turns personal-data writes on, one ad account at a time; every account starts off, and
 * turning one off takes effect at once, for reviews already prepared too. An operator may prepare an upload; only the
 * owner runs one. A removal only reduces what a platform holds, so an operator may run it (the owner's choice of
 * 2026-09-30).
 */
export type Direction = 'add' | 'remove';
/** One person's row as sent: the hash of each schema key ('' when unknown), then the value of each field. */
export type Row = (string | number | null)[];
/** What a reviewed family that sends data about people declares (ReviewedFamily.personalData). */
export interface PersonalDataSpec {
  /** The platform, for the review's statements. */
  readonly platform: string;
  /** The requests that carry people, as '<gateway> <catalog action>': their arguments are scrubbed from error audits. */
  readonly actions: readonly string[];
  /** Each key the platform takes, and its normalization; undefined refuses the value. */
  readonly keys: Readonly<Record<string, (value: string) => string | undefined>>;
  /** The platform's documented number of rows per request; AMCP never sends more than 10,000. */
  readonly maxRows: number;
  /** Whether the request adds people or removes them; undefined for a request of the family that sends none. */
  direction(plan: CompiledRequest): Direction | undefined;
  /** The request body carrying these hashed rows; with no rows, the body the review keeps. */
  body(plan: CompiledRequest, rows: Row[]): JsonObject;
  /**
   * Values each row carries beside the people's keys (a conversion's event), in this order: each normalizes a value, or
   * answers undefined to refuse the row. They are sent as they are, never hashed, and kept only inside the digest. A
   * family with fields takes each row as an object of keys and fields.
   */
  readonly fields?: Readonly<Record<string, (value: unknown) => string | number | null | undefined>>;
  /**
   * A reason to refuse a row whose fields do not go together (a purchase without its value), or undefined. `hasKey` is
   * false when the row names no person by a key, which only a family with `keysOptional` accepts.
   */
  row?(fields: Record<string, string | number | null>, hasKey: boolean): string | undefined;
  /** True when a row may name no person by a key and rely on its fields instead (a conversion by click ID). */
  readonly keysOptional?: boolean;
  /**
   * The request's own settings beside the people (the list or conversion action, the platform's consent fields),
   * validated from the caller's payload; kept in the review. Without it, a payload is refused.
   */
  settings?(plan: CompiledRequest, direction: Direction): JsonObject;
  /** Refuses the whole batch at prepare and again at execution (events older than the platform accepts). */
  check?(rows: Row[], now: number): void;
  /** What the review shows of the rows, in aggregate only (events by name, value by currency). */
  summarize?(rows: Row[]): JsonObject;
}
/** The review's record of an upload: counts, digest and confirmations, never the people. */
export interface PersonalDataRecord extends JsonObject {
  platform: string;
  direction: Direction;
  schema: string[];
  fields?: string[];
  counts: {rows: number; sent: number; duplicates: number; refused: Record<string, number>};
  digest: string;
  summary?: JsonObject;
  settings?: JsonObject;
  confirmations?: JsonObject;
}

const maxRows = 10000,
  hex = /^[0-9a-f]{64}$/;
export function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
export const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** Emails: trimmed and lower-cased (Meta's customer-file guide; Google Ads "after normalization"). */
export function normalizeEmail(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(v) ? v : undefined;
}
/**
 * Phones in E.164: a leading + and 8 to 15 digits; spaces, dots, dashes and brackets are dropped. The value hashed is
 * the digits with the country code, as Meta's example hashes "15559876543". A number without its country code is
 * refused: its country cannot be known.
 */
export function normalizePhone(value: string): string | undefined {
  const v = value.trim().replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{7,14}$/.test(v) ? v.slice(1) : undefined;
}

/**
 * Google's emails (Data Manager formatting guide, read 2026-09-30): lower-cased, all whitespace removed; for gmail.com
 * and googlemail.com, the dots and a "+" suffix before the @ removed.
 */
export function normalizeGoogleEmail(value: string): string | undefined {
  const v = value.replace(/\s+/g, '').toLowerCase();
  if (v.length > 254 || !/^[^@]+@[^@]+\.[^@.]+$/.test(v)) return undefined;
  const at = v.lastIndexOf('@'),
    domain = v.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return v;
  const local = v.slice(0, at).split('+')[0]!.replaceAll('.', '');
  return local ? local + '@' + domain : undefined;
}
/** Google's phones: E.164 with its plus sign, "+18005550100" (same guide). */
export function normalizeGooglePhone(value: string): string | undefined {
  const digits = normalizePhone(value);
  return digits ? '+' + digits : undefined;
}
/** The digest of a hashed batch: its direction, schema and sorted rows (and field names, when rows carry fields). */
export function digestOf(direction: Direction, schema: string[], rows: Row[], fields?: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({direction, schema, ...(fields?.length ? {fields} : {}), rows}))
    .digest('hex');
}
/**
 * True when `rows`, as a body carries them, are the reviewed batch: none (the body the review keeps), or exactly the
 * sorted rows whose digest the review recorded.
 */
export function reviewedRows(record: unknown, rows: unknown): boolean {
  if (!object(record) || !Array.isArray(rows)) return false;
  if (!rows.length) return true;
  const schema = record.schema as string[],
    fields = (record.fields as string[] | undefined) ?? [];
  if (
    rows.length !== record.counts?.sent ||
    rows.some(
      r =>
        !Array.isArray(r) ||
        r.length !== schema.length + fields.length ||
        r.slice(0, schema.length).some(v => v !== '' && !(typeof v === 'string' && hex.test(v))),
    )
  )
    return false;
  return digestOf(record.direction, schema, rows as Row[], fields) === record.digest;
}
/** The hashed batch of one upload, held in memory only. */
export interface HashedBatch {
  schema: string[];
  rows: Row[];
  record: PersonalDataRecord;
}
/**
 * Normalizes and hashes `people` in memory: {schema: key or keys, rows: one value (or one value per key) per person,
 * hashed: true when every value is already a SHA-256 hex digest}. A family with fields takes each row as an object of
 * the keys and fields. An empty value is an unknown key; a row with no known value, or with a value that is neither
 * valid plain text nor a valid hash, or with an invalid field, is refused and counted, never sent. Duplicates are
 * removed. The digest covers the schema, the fields and the sorted rows. `now` runs the family's time checks; inspect,
 * a local contract check, passes null.
 */
export function hashPeople(
  people: unknown,
  spec: PersonalDataSpec,
  direction: Direction,
  now: number | null = Date.now(),
): HashedBatch {
  if (!object(people))
    fail('PERSONAL_DATA_REQUIRED', 'Send the people as people: {schema, rows, hashed?} beside the request.');
  const extra = Object.keys(people).filter(k => !['schema', 'rows', 'hashed'].includes(k));
  if (extra.length)
    fail('PERSONAL_DATA_INVALID', 'people takes schema, rows and hashed; unqualified: ' + extra.join(', ') + '.');
  const schema = (Array.isArray(people.schema) ? people.schema : [people.schema]).map(k => String(k));
  if (!schema.length || schema.some(k => !Object.hasOwn(spec.keys, k)) || new Set(schema).size !== schema.length)
    fail('PERSONAL_DATA_INVALID', 'schema names each key once, from ' + Object.keys(spec.keys).join(', ') + '.', {
      accepted: Object.keys(spec.keys),
    });
  if (people.hashed !== undefined && typeof people.hashed !== 'boolean')
    fail('PERSONAL_DATA_INVALID', 'hashed is true or false.');
  const prehashed = people.hashed === true,
    limit = Math.min(spec.maxRows, maxRows);
  if (!Array.isArray(people.rows) || !people.rows.length)
    fail('PERSONAL_DATA_INVALID', 'rows lists the people, one row per person.');
  if (people.rows.length > limit)
    fail(
      'PERSONAL_DATA_INVALID',
      'One upload holds at most ' +
        limit +
        ' rows (' +
        spec.platform +
        '’s batch size, and AMCP’s limit of 10,000). Split the list.',
      {rows: people.rows.length, max_rows: limit},
    );
  const refused: Record<string, number> = {},
    unique = new Set<string>(),
    kept: Row[] = [],
    fields = Object.keys(spec.fields ?? {});
  let duplicates = 0;
  const refuse = (reason: string) => (refused[reason] = (refused[reason] ?? 0) + 1);
  for (const row of people.rows as unknown[]) {
    if (fields.length && (!object(row) || Object.keys(row).some(k => !schema.includes(k) && !fields.includes(k)))) {
      refuse('row_shape');
      continue;
    }
    const values = fields.length
      ? schema.map(k => (row as JsonObject)[k])
      : schema.length === 1 && !Array.isArray(row)
        ? [row]
        : row;
    if (!Array.isArray(values) || values.length !== schema.length) {
      refuse('row_shape');
      continue;
    }
    const out: Row = [];
    let bad: string | undefined;
    for (let i = 0; i < schema.length && !bad; i++) {
      const v = values[i];
      if (v === '' || v === null || v === undefined) {
        out.push('');
        continue;
      }
      if (typeof v !== 'string') {
        bad = 'not_text';
        continue;
      }
      if (prehashed) {
        if (hex.test(v)) out.push(v);
        else bad = 'not_sha256_hex';
        continue;
      }
      const normalized = spec.keys[schema[i]!]!(v);
      if (normalized === undefined) bad = 'invalid_' + schema[i]!.toLowerCase();
      else out.push(createHash('sha256').update(normalized, 'utf8').digest('hex'));
    }
    const own: Record<string, string | number | null> = {};
    for (const f of fields) {
      if (bad) break;
      const v = spec.fields![f]!((row as JsonObject)[f]);
      if (v === undefined) bad = 'invalid_' + f;
      else own[f] = v;
    }
    const hasKey = out.some(v => v !== '');
    if (!bad && fields.length) bad = spec.row?.(own, hasKey);
    if (bad) refuse(bad);
    else if (!hasKey && !spec.keysOptional) refuse('empty');
    else {
      out.push(...fields.map(f => own[f]!));
      const key = JSON.stringify(out);
      if (unique.has(key)) duplicates++;
      else {
        unique.add(key);
        kept.push(out);
      }
    }
  }
  if (!kept.length) fail('PERSONAL_DATA_INVALID', 'No row holds a valid value; nothing would be sent.', {refused});
  const order = (r: Row) => JSON.stringify(r);
  kept.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  if (now !== null) spec.check?.(kept, now);
  const digest = digestOf(direction, schema, kept, fields);
  return {
    schema,
    rows: kept,
    record: {
      platform: spec.platform,
      direction,
      schema,
      ...(fields.length ? {fields} : {}),
      counts: {rows: people.rows.length, sent: kept.length, duplicates, refused},
      digest,
      ...(spec.summarize ? {summary: spec.summarize(kept)} : {}),
    },
  };
}

const eea = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
];
/** The law each named country's people fall under, as the policy names it; elsewhere the uploader names it. */
function lawOf(country: string): string | undefined {
  if (country === 'SA') return 'Saudi Arabia: the Personal Data Protection Law (PDPL), supervised by SDAIA';
  if (country === 'AE')
    return 'United Arab Emirates: Federal Decree-Law No. 45 of 2021 on the protection of personal data';
  if (country === 'GB') return 'United Kingdom: the UK GDPR';
  if (eea.includes(country)) return 'European Economic Area: the GDPR';
}
/**
 * The uploader's confirmations for adding people (policy rules 4 and 6): the countries of the people in the list and
 * the law that applies there, consent or another lawful basis, and the platform's own customer-list terms, accepted
 * in the platform. People in Saudi Arabia also need the PDPL's three confirmations. A removal needs none.
 */
export function confirmations(input: unknown, direction: Direction, platform: string): JsonObject | undefined {
  if (direction === 'remove') {
    if (input !== undefined)
      fail(
        'INVALID_ARGUMENT',
        'A removal needs no consent or country confirmations: it only reduces what the platform holds. Remove personal_data.',
      );
    return undefined;
  }
  const statement = {
    consent:
      'The people in this list agreed to their data being used for advertising on ' +
      platform +
      ', or another lawful basis applies under the law named for their country.',
    platform_terms:
      platform + '’s customer-list terms were accepted in ' + platform + ' itself; AMCP never accepts them.',
  };
  if (!object(input))
    fail(
      'PERSONAL_DATA_CONFIRMATION_REQUIRED',
      'Adding people needs personal_data: {countries, consent_confirmed, platform_terms_confirmed} beside the request, confirmed by the uploader.',
      {statements: statement},
    );
  const extra = Object.keys(input).filter(
    k => !['countries', 'law', 'consent_confirmed', 'platform_terms_confirmed', 'pdpl'].includes(k),
  );
  if (extra.length)
    fail(
      'INVALID_ARGUMENT',
      'personal_data takes countries, law, consent_confirmed, platform_terms_confirmed and pdpl; unqualified: ' +
        extra.join(', ') +
        '.',
    );
  const countries = Array.isArray(input.countries) ? input.countries.map(c => String(c)) : [];
  if (!countries.length || countries.some(c => !/^[A-Z]{2}$/.test(c)) || new Set(countries).size !== countries.length)
    fail(
      'PERSONAL_DATA_CONFIRMATION_REQUIRED',
      'Name the countries of the people in the list, as ISO 3166-1 alpha-2 codes (SA, AE, ...): a list with no country is refused.',
    );
  const laws: string[] = [],
    unnamed = countries.filter(c => !lawOf(c));
  for (const c of countries) {
    const law = lawOf(c);
    if (law && !laws.includes(law)) laws.push(law);
  }
  if (unnamed.length) {
    const law = typeof input.law === 'string' ? input.law.trim() : '';
    if (!law || law.length > 300 || /[\u0000-\u001f]/.test(law))
      fail(
        'PERSONAL_DATA_CONFIRMATION_REQUIRED',
        'Name the privacy law that applies to the people in ' +
          unnamed.join(', ') +
          ' in law (at most 300 characters).',
        {countries: unnamed},
      );
    laws.push(unnamed.join(', ') + ': ' + law + ' (named by the uploader)');
  } else if (input.law !== undefined)
    fail('INVALID_ARGUMENT', 'law is for countries AMCP does not name a law for; these countries need none.');
  if (input.consent_confirmed !== true)
    fail('PERSONAL_DATA_CONFIRMATION_REQUIRED', 'Confirm consent: ' + statement.consent, {
      field: 'consent_confirmed',
    });
  if (input.platform_terms_confirmed !== true)
    fail('PERSONAL_DATA_CONFIRMATION_REQUIRED', 'Confirm the platform terms: ' + statement.platform_terms, {
      field: 'platform_terms_confirmed',
    });
  const pdplStatements = {
    consent: 'The people in Saudi Arabia consented to marketing use, or another basis the PDPL allows applies.',
    transfer_abroad:
      'Sending their data to ' + platform + ', outside the Kingdom, meets the PDPL’s rules for transfers abroad.',
    withdrawal_removal:
      'People who withdraw consent are removed from this list, through AMCP’s removal or ' + platform + '.',
  };
  const saudi = countries.includes('SA');
  if (saudi) {
    const p = object(input.pdpl) ? input.pdpl : {};
    const missing = Object.keys(pdplStatements).filter(k => p[k] !== true);
    if (missing.length || Object.keys(p).some(k => !Object.hasOwn(pdplStatements, k)))
      fail(
        'PERSONAL_DATA_CONFIRMATION_REQUIRED',
        'People in Saudi Arabia need the PDPL’s three confirmations in pdpl: {consent, transfer_abroad, withdrawal_removal}, each true.',
        {missing, statements: pdplStatements},
      );
  } else if (input.pdpl !== undefined) fail('INVALID_ARGUMENT', 'pdpl is for people in Saudi Arabia (SA).');
  return {
    countries,
    laws,
    confirmed: {...statement, ...(saudi ? {pdpl: pdplStatements} : {})},
    note: 'Confirmed by the uploader. This is not legal advice: counsel confirms the law for each country served.',
  };
}

/**
 * The input as the audit may keep it: the people replaced by their number of rows, and the arguments of a request
 * that carries people (`actions`) scrubbed, should a caller have put people there.
 */
export function withoutPeople(tool: string, input: JsonObject, actions: ReadonlySet<string> = new Set()): JsonObject {
  if (tool !== 'amcp_write') return input;
  let out = input;
  if (input.people !== undefined) {
    const rows = object(input.people) && Array.isArray(input.people.rows) ? input.people.rows.length : null;
    out = {...out, people: {withheld: 'personal data', rows}};
  }
  const args = object(input.arguments) ? input.arguments : undefined,
    native = args && object(args.arguments) ? args.arguments : args;
  if (args && actions.has(String(input.gateway) + ' ' + String(native?.action)))
    out = {...out, arguments: scrubPeople(args) as JsonObject};
  return out;
}
/**
 * Removes from a platform's reply anything that may be a person's data before it is kept or returned: a platform may
 * echo a value back. Only hashes leave AMCP, so a reply can hold only hashes; e-mail addresses are removed too.
 */
export function scrubPeople(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubPeople);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubPeople(v)]));
  if (typeof value === 'string')
    return value
      .replace(/[0-9a-fA-F]{64}/g, '[personal data]')
      .replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+/g, '[personal data]');
  return value;
}
/** An error as it may be kept and returned after a personal-data request: its details scrubbed of people. */
export function scrubError(e: unknown): unknown {
  if (!(e instanceof MirrorError)) return e;
  return new MirrorError(
    e.code,
    String(scrubPeople(e.message)),
    scrubPeople(e.details) as JsonObject,
    e.status,
    e.retryable,
  );
}
