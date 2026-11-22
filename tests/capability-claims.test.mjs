import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {providerContractView} from '../dist/src/contract-evidence.js';

// MCP-10 item 4: the TikTok and Snapchat contract text and guide called reviewed families "unqualified" or "not
// available" (identity deletion and provisioning, custom-conversion edits, saved-audience deletion, Smart+ ad groups,
// ads and budgets, Snapchat segment deletion) while the ledger listed them as reviewed writes. This test parses those
// clauses and cross-checks them against the ledger.
const marker = /\b(?:stays?|remains?) unqualified|\bnot qualified\b|\bNot available\b/;
/** A span without the parentheticals in it, at every depth (the innermost first, until none is left). */
const withoutParentheticals = span => {
  for (let before = ''; before !== span;) {
    before = span;
    span = span.replace(/\([^()]*\)/g, '');
  }
  return span;
};
/** Each clause that calls something unqualified or unavailable, with the subject it qualifies. */
export function unqualifiedClauses(text) {
  const flat = text.replace(/\s+/g, ' '),
    out = [],
    pairs = [],
    open = [];
  // A parenthetical can hold another (the golden's TikTok sentences say "refused with code 40118 or with code 40002 (the message that ...) and nothing is created"): every pair of
  // brackets is found as brackets match, and an outer one is read without the inner one, which is read on its own.
  for (let i = 0; i < flat.length; i++)
    if (flat[i] === '(') open.push(i);
    else if (flat[i] === ')' && open.length) pairs.push([open.pop(), i]);
  // "subject (a, b and c stay unqualified; d is listed below)": each part of the parenthetical, with the clause before it.
  for (const [from, to] of pairs.sort((a, b) => a[0] - b[0])) {
    const start = Math.max(flat.lastIndexOf('; ', from), flat.lastIndexOf('. ', from)),
      subject = flat.slice(start < 0 ? 0 : start + 2, from);
    for (const part of withoutParentheticals(flat.slice(from + 1, to)).split(/;\s*/))
      if (marker.test(part)) out.push({subject, clause: part});
  }
  // Whole sentences outside parentheses: "X remains unqualified.", "Not available: ...".
  for (const sentence of withoutParentheticals(flat).split(/(?<=\.)\s+/))
    if (marker.test(sentence)) out.push({subject: sentence, clause: sentence});
  return out;
}
/** A claim that a reviewed family is unqualified: the clause's subject and wording that name it. */
const claims = [
  {
    name: 'TikTok identity deletion',
    subject: /identit/i,
    clause: /delet/i,
    actions: ['tiktok_native_action/tiktok_identity_delete'],
  },
  {
    name: 'TikTok identity provisioning',
    subject: /./,
    clause: /identity (?:provisioning|creation)|\/identity\/create\//i,
    actions: ['tiktok_native_action/tiktok_identity_create'],
  },
  {
    name: 'TikTok custom conversion updates and deletion',
    subject: /custom conversion/i,
    clause: /update|delet/i,
    actions: [
      'tiktok_native_action/tiktok_custom_conversion_update',
      'tiktok_native_action/tiktok_custom_conversion_delete',
    ],
  },
  {
    name: 'TikTok saved audience deletion',
    subject: /saved audience/i,
    clause: /delet/i,
    actions: ['tiktok_native_action/tiktok_dmp_saved_audience_delete'],
  },
  {
    name: 'TikTok Upgraded Smart+ ad group budgets',
    subject: /budget/i,
    clause: /Smart\+ ad groups?/,
    actions: ['tiktok_native_action/tiktok_smart_plus_adgroup_budget_update'],
  },
  {
    name: 'TikTok Upgraded Smart+ ad groups and ads',
    subject: /./,
    clause: /Smart\+ (?:and \/identity|ad groups and ads)/,
    actions: [
      'tiktok_native_action/tiktok_smart_plus_adgroup_create',
      'tiktok_native_action/tiktok_smart_plus_ad_create',
    ],
  },
  {
    name: 'Snapchat segment deletion',
    subject: /./,
    clause: /segment deletion/i,
    actions: ['snapchat_native_action/snapchat_audience_delete'],
  },
];
const contradictions = text =>
  unqualifiedClauses(text).flatMap(c =>
    claims.filter(k => k.subject.test(c.subject) && k.clause.test(c.clause)).map(k => k.name + ': ' + c.clause),
  );
const strings = value =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];

test('every family a claim names is a reviewed write in the ledger, so the check guards real families', () => {
  const ledger = new Map(actionContracts(new Registry()).map(r => [r.gateway + '/' + r.action, r.status]));
  for (const claim of claims)
    for (const action of claim.actions) assert.equal(ledger.get(action), 'reviewed_write_family', claim.name);
});
test('the strings before MCP-10 are caught: each called a reviewed TikTok or Snapchat family unqualified', () => {
  const before = [
    'custom (CUSTOMIZED_USER) identity creation with a square library avatar (identity deletion and TikTok-account identities stay unqualified)',
    'manual ad group lifetime and next-day scheduled budget updates under the owner spending policy (campaign-budget-optimized and Smart+ ad groups stay unqualified)',
    'custom conversion creation on an owned pixel with documented rules and read-back (app sources, custom event mapping, updates and deletion stay unqualified)',
    'saved audience creation with documented targeting fields and owned, available referenced audiences (deletion stays unqualified)',
    'segment name/description/retention updates (user uploads, segment deletion and pixel/mobile/engagement rule audiences stay unqualified)',
    'Discover an authorized existing identity; identity provisioning remains unqualified.',
    'Smart+ has a different creative_list/ad_configuration contract. Smart+ and /identity/create/ remain unqualified reviewed writes.',
    'and PO number. Smart+ ad groups and ads, and campaign edits, are not qualified yet.',
    '- Not available: adding or removing users (customer data), segment deletion, and pixel, mobile or engagement rule audiences.',
  ];
  for (const text of before) assert.ok(contradictions(text).length > 0, text);
});
test('a parenthetical inside a parenthetical is read as brackets match: the outer one is not lost and the inner one does not make the whole text one sentence', () => {
  // r25-field3-merge, golden commit: livefix's TikTok sentences nest ("... refused by TikTok with code 40118 or with code 40002 (the message that ...) and nothing is created"). The
  // reader took the innermost brackets only, so the outer ones stayed in the text, the text became one "sentence" with a marker in it, and five families were named unqualified.
  const nested =
    'manual ad group budget updates (an advertiser outside the allowlist is refused with code 40118 or with code 40002 (the message that the account has no access) and nothing is created; Smart+ ad groups stay unqualified)';
  assert.deepEqual(
    unqualifiedClauses(nested).map(c => c.clause),
    ['Smart+ ad groups stay unqualified'],
  );
  assert.ok(
    contradictions(nested).length > 0,
    'a reviewed family called unqualified in the outer parenthetical is still found',
  );
  const clean =
    'campaigns (refused with code 40118 or with code 40002 (the message that the account has no access (any text) at all) and nothing is created); a pack (one (two (three)))';
  assert.deepEqual(unqualifiedClauses(clean), []);
  assert.deepEqual(
    unqualifiedClauses('x (a (b) c) y. Z stays unqualified. W.').map(c => c.clause),
    ['Z stays unqualified.'],
  );
});
test('no TikTok or Snapchat contract text, trap or guide clause calls a reviewed family unqualified', () => {
  const sources = {
    tiktok_contract: strings(providerContractView('tiktok_native_action')).join(' '),
    snapchat_contract: strings(providerContractView('snapchat_native_action')).join(' '),
    guide: fs.readFileSync('Skills/amcp-campaign-builder/references/tiktok-snapchat.md', 'utf8'),
  };
  for (const [name, text] of Object.entries(sources)) assert.deepEqual(contradictions(text), [], name);
  // The corrected text still says what stays unqualified.
  assert.match(sources.tiktok_contract, /TikTok-account identities stay unqualified/);
  assert.match(sources.snapchat_contract, /user uploads and pixel\/mobile\/engagement rule audiences stay unqualified/);
});
