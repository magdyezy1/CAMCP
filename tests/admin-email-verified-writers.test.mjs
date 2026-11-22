// r25-admin-email: AMCP_ADMIN_EMAIL gives the second-owner role to an account whose address matches, and relies on one fact:
// an address enters amcp_users.email only after it was verified (an e-mail link, or a Google or Apple token whose claim
// says so; Facebook gives none). This ratchet reads the source for every place that writes that column or creates an
// account, so a new writer cannot silently add an unverified address. A new entry here is a reviewed decision that its
// address was proved first, and it belongs in server/admin-email.ts (adminEmailEligible) and docs/operations/SECOND-OWNER.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function sources(directory) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, directory), {withFileTypes: true})) {
    const relative = directory + '/' + entry.name;
    if (entry.isDirectory()) found.push(...sources(relative));
    else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(relative);
  }
  return found;
}
const files = ['src', 'server', 'tools'].flatMap(sources);
const text = file => fs.readFileSync(path.join(root, file), 'utf8');
/** Files and the number of times each matches `pattern` (comments are not code: lines starting with // or * are skipped). */
function count(pattern) {
  const out = {};
  for (const file of files) {
    const code = text(file)
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const n = [...code.matchAll(pattern)].length;
    if (n) out[file] = n;
  }
  return out;
}

test('the address of an account is written only where it was verified first: owner setup, a new account, an address change', () => {
  // Statements that insert an account row, or set its address.
  const writers = count(
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+amcp_users|REPLACE\s+INTO\s+amcp_users|UPDATE\s+amcp_users\s+SET\s+email\b/gi,
  );
  assert.deepEqual(writers, {
    // Owner setup: the address was verified by the emailed link of the administrator's session (finishOwner).
    'server/account-security.ts': 1,
    // A new account (newUser), and the verified address change (finishEmail, kind email).
    'server/user-accounts.ts': 2,
  });
});

test('accounts are created only by the three flows that prove the address: the registration link, the invitation link and a Google or Apple claim', () => {
  const creators = count(/\.newUser\(/g);
  assert.deepEqual(creators, {
    // finishEmail, kind register: after the emailed link.
    'server/user-accounts.ts': 1,
    // accept: the invitation's emailed link; the address is the invited one.
    'server/account-security.ts': 1,
    // finish: the address is the provider's, and only when its signed token says it is verified (Facebook gives none).
    'server/social-signin.ts': 1,
  });
});

test('Facebook gives AMCP no address, so a Facebook identity can never carry the configured one', () => {
  const social = text('server/social-signin.ts'),
    facebook = social.slice(
      social.indexOf("if (provider === 'facebook')"),
      social.indexOf('if (typeof tokens.id_token'),
    );
  assert.match(facebook, /email: null/);
  assert.doesNotMatch(facebook, /\binfo\.email\b/);
  // A Google or Apple address counts only when the signed token says it is verified.
  assert.match(social, /email_verified === true \|\| payload\.email_verified === 'true'/);
  assert.match(social, /verified && typeof payload\.email === 'string' \? accountEmail\(payload\.email\) : null/);
});
