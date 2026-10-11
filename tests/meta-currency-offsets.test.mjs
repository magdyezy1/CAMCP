import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {
  metaCurrencyOffset,
  metaCurrencyOffsetsPinned,
  metaCurrencySource,
  nativeAmount,
  parseMetaCurrencyCapture,
  setMetaCurrencyOffsetsForTest,
} from '../dist/src/budget-units.js';
import {checkSpendPolicy, saveSpendPolicy} from '../dist/src/spend-policy.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';

/**
 * WRT-07 remainder: Meta's currency offsets are pinned from Meta's Marketing API Currencies page (captured 2026-10-11,
 * .mirror/VENDOR/meta-currencies.json). Before, the capture was absent, so every Meta cap stated in account currency
 * was refused and owners typed Meta caps in cents (a 100x mistake loosens or blocks). These tests run against the
 * pinned file itself, not a synthetic table: they fail if it is removed, edited without a new digest, or loses a row.
 */
const meta = 'meta_native_action',
  account = 'act_42',
  capturePath = '.mirror/VENDOR/meta-currencies.json',
  key = Buffer.alloc(32, 63).toString('base64'),
  owner = {tenantId: 'meta-currencies', userId: 'owner', role: 'admin'},
  actor = {...owner, userId: 'operator', role: 'operator'};
const capture = () => JSON.parse(fs.readFileSync(capturePath, 'utf8'));
const seal = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

function store() {
  const s = new Store(':memory:', key);
  s.putConnection(
    owner,
    {
      id: 'meta',
      tenantId: owner.tenantId,
      gateway: meta,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  return s;
}
const savePolicy = (s, policy) =>
  saveSpendPolicy(s, owner, {gateway: meta, account_id: account, connection_id: 'meta', confirmed: true, policy});
/** A Meta campaign create with a daily budget in native units (the account currency times its offset). */
const metaCampaign = dailyBudget => ({
  gateway: meta,
  accountId: account,
  action: 'meta_ad_account_id_campaigns_create',
  method: 'POST',
  path: '/v25.0/' + account + '/campaigns',
  headers: {},
  query: {},
  body: {name: 'C', status: 'PAUSED', daily_budget: dailyBudget},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic WRT-07 Meta currency caps',
  warnings: [],
});
/** The review's state read of the ad account, which names its currency. */
const accountState = currency => [{id: account, name: 'Synthetic', currency}];

test('the pinned Meta capture is sealed, sourced from Meta’s documentation and loaded by the server', () => {
  setMetaCurrencyOffsetsForTest(undefined);
  const c = capture();
  assert.equal(c.source_url, 'https://developers.facebook.com/docs/marketing-api/currencies');
  assert.equal(c.captured_at, '2026-10-11');
  assert.equal(c.sha256, seal(c.currencies), 'the digest seals the rows as recorded');
  assert.equal(c.currencies.length, 66);
  assert.equal(new Set(c.currencies.map(r => r.code)).size, 66);
  assert.match(c.budget_unit_evidence.source_url, /^https:\/\/developers\.facebook\.com\//);
  assert.equal(metaCurrencyOffsetsPinned(), true);
  assert.deepEqual(metaCurrencySource(), {source_url: c.source_url, captured_at: '2026-10-11', currencies: 66});
});

test('Meta offsets are Meta’s own, not ISO 4217: zero-decimal, two-decimal and unlisted currencies', () => {
  setMetaCurrencyOffsetsForTest(undefined);
  // Two-decimal currencies, including the Gulf and Arab ones the target market spends in: cents.
  for (const code of ['USD', 'EUR', 'GBP', 'SAR', 'AED', 'EGP', 'QAR'])
    assert.equal(metaCurrencyOffset(code), 100, code);
  // Zero-decimal currencies: whole units.
  for (const code of ['JPY', 'KRW', 'CLP', 'VND', 'PYG', 'ISK']) assert.equal(metaCurrencyOffset(code), 1, code);
  // Where Meta differs from ISO 4217 minor units, Meta's table wins: IDR, COP, HUF and TWD in whole units (ISO: 2
  // decimals), BHD and JOD in hundredths (ISO: 3).
  for (const code of ['IDR', 'COP', 'HUF', 'TWD', 'CRC']) assert.equal(metaCurrencyOffset(code), 1, code);
  for (const code of ['BHD', 'JOD']) assert.equal(metaCurrencyOffset(code), 100, code);
  // Not on Meta's page: no offset, never a guess from ISO (KWD would be 1000 there).
  for (const code of ['KWD', 'OMR', 'IQD', 'MAD', 'usd', 'XXX'])
    assert.equal(metaCurrencyOffset(code), undefined, code);
  assert.equal(nativeAmount(meta, 100, 'USD'), 10000);
  assert.equal(nativeAmount(meta, 100, 'JPY'), 100);
  assert.equal(nativeAmount(meta, 250.5, 'SAR'), 25050);
  assert.equal(nativeAmount(meta, 100, 'KWD'), undefined);
  assert.equal(nativeAmount(meta, 100, undefined), undefined);
});

test('a Meta cap in USD is saved as 10000 native and refuses a larger daily budget; JPY as 100', () => {
  setMetaCurrencyOffsetsForTest(undefined);
  const s = store();
  try {
    const usd = savePolicy(s, {enforcement: 'block', max_budget_currency: 100, currency: 'USD'});
    assert.equal(usd.max_budget_native, 10000);
    assert.equal(usd.max_budget_currency, 100);
    assert.equal(usd.currency, 'USD');
    // The saved policy names the offset and the capture that converted it.
    assert.equal(usd.native_unit.perCurrencyUnit, 100);
    assert.match(usd.native_unit.evidence, /developers\.facebook\.com\/docs\/marketing-api\/currencies \(2026-10-11\)/);
    assert.equal(checkSpendPolicy(s, actor, metaCampaign('9000'), accountState('USD')).exceeded, undefined);
    assert.equal(checkSpendPolicy(s, actor, metaCampaign('10000'), accountState('USD')).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(s, actor, metaCampaign('20000'), accountState('USD')), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    // The same USD cap never applies, converted or not, to an account spending in another currency.
    assert.throws(() => checkSpendPolicy(s, actor, metaCampaign('9000'), accountState('JPY')), {
      code: 'POLICY_CURRENCY_MISMATCH',
    });
  } finally {
    s.close();
  }
  const yen = store();
  try {
    const jpy = savePolicy(yen, {enforcement: 'block', max_budget_currency: 100, currency: 'JPY'});
    assert.equal(jpy.max_budget_native, 100);
    assert.equal(jpy.native_unit.perCurrencyUnit, 1);
    assert.equal(checkSpendPolicy(yen, actor, metaCampaign('100'), accountState('JPY')).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(yen, actor, metaCampaign('150'), accountState('JPY')), {
      code: 'POLICY_BUDGET_LIMIT',
    });
  } finally {
    yen.close();
  }
});

test('a Meta cap in a currency the capture does not list, or with no currency, is still refused', () => {
  setMetaCurrencyOffsetsForTest(undefined);
  const s = store();
  try {
    const refusedForMeta = e =>
      e.code === 'INVALID_POLICY' && /pinned capture of Meta/.test(e.message) && e.details.gateway === meta;
    assert.throws(() => savePolicy(s, {max_budget_currency: 100, currency: 'KWD'}), refusedForMeta);
    assert.throws(() => savePolicy(s, {max_budget_currency: 100}), refusedForMeta);
    // The account's currency from a live check binds a cap saved without one, and KWD is not on Meta's page either.
    rememberAccountMetadata(s, owner.tenantId, 'meta', account, {name: 'Kuwait', currency: 'KWD', timezone: 'UTC'});
    assert.throws(() => savePolicy(s, {max_budget_currency: 100}), refusedForMeta);
    // Native caps stay valid for every currency.
    assert.equal(savePolicy(s, {max_budget_native: 5000}).max_budget_native, 5000);
    // A workspace default states the currency per platform; without it a Meta cap cannot convert.
    assert.throws(
      () =>
        saveSpendPolicy(s, owner, {
          scope: 'workspace',
          confirmed: true,
          policy: {per_gateway: {[meta]: {max_budget_currency: 25}}},
        }),
      refusedForMeta,
    );
    const workspace = saveSpendPolicy(s, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {per_gateway: {[meta]: {max_budget_currency: 25, currency: 'SAR'}}},
    });
    assert.equal(workspace.per_gateway[meta].max_budget_native, 2500);
  } finally {
    s.close();
  }
});

test('a tampered, partial or foreign Meta capture is not used, so Meta caps fall back to native units', () => {
  const c = capture(),
    rows = c.currencies,
    reseal = changed => ({...c, currencies: changed, sha256: seal(changed)});
  assert.equal(parseMetaCurrencyCapture(c).offsets.USD, 100);
  assert.equal(Object.isFrozen(parseMetaCurrencyCapture(c).offsets), true);
  // An edited row without a new digest.
  const edited = rows.map(r => (r.code === 'USD' ? {...r, offset: 1} : r));
  assert.equal(parseMetaCurrencyCapture({...c, currencies: edited}), null);
  // Sealed again, but with an offset Meta does not use, a duplicate code or a malformed code: rejected whole.
  assert.equal(parseMetaCurrencyCapture(reseal(rows.map(r => (r.code === 'USD' ? {...r, offset: 7} : r)))), null);
  assert.equal(parseMetaCurrencyCapture(reseal([...rows, {code: 'USD', name: 'again', offset: 1}])), null);
  assert.equal(parseMetaCurrencyCapture(reseal([...rows, {code: 'kwd', name: 'lower', offset: 1000}])), null);
  assert.equal(parseMetaCurrencyCapture(reseal([])), null);
  // Provenance is required: a Meta documentation source and a capture date.
  assert.equal(parseMetaCurrencyCapture({...c, source_url: 'https://example.com/currencies'}), null);
  assert.equal(parseMetaCurrencyCapture({...c, captured_at: undefined}), null);
  assert.equal(parseMetaCurrencyCapture(undefined), null);
  // Without a usable capture the server refuses Meta caps in currency, as before the capture existed.
  setMetaCurrencyOffsetsForTest(null);
  const s = store();
  try {
    assert.equal(metaCurrencyOffsetsPinned(), false);
    assert.throws(() => savePolicy(s, {max_budget_currency: 100, currency: 'USD'}), {code: 'INVALID_POLICY'});
  } finally {
    setMetaCurrencyOffsetsForTest(undefined);
    s.close();
  }
});

test('owner health lists Meta’s unit while the capture is loaded, and the settings page offers Meta caps in currency', () => {
  const s = store();
  try {
    setMetaCurrencyOffsetsForTest(undefined);
    const health = ownerOperations(s, {action: 'health'}, owner);
    assert.equal(health.meta_currency_offsets, 'pinned');
    assert.equal(health.meta_currency_source.captured_at, '2026-10-11');
    assert.match(health.budget_units[meta].unit, /minor units/);
    assert.match(health.budget_units[meta].evidence, /100 USD is 10000, 100 JPY is 100/);
    assert.equal(health.budget_units.google_ads_native_action.unit, 'micros');
    // The settings page's own unit note, in English and Arabic: Meta converts, and the evidence stays literal.
    const source = fs.readFileSync('web/owner-operations.js', 'utf8'),
      helpers = source.slice(source.indexOf('const platformName ='), source.indexOf('const policyMoney ='));
    for (const locale of ['en', 'ar']) {
      const context = createContext({
          Intl,
          document: {addEventListener() {}},
          catalog: JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
        }),
        run = code => new Script(code).runInContext(context);
      run(fs.readFileSync('web/localization.js', 'utf8'));
      run(
        `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
      );
      run(helpers);
      context.h = JSON.parse(JSON.stringify(health));
      const note = run(`policyUnitNote(h, ${JSON.stringify(meta)})`);
      assert.match(note, /100 USD is 10000, 100 JPY is 100/, locale);
      if (locale === 'en') assert.match(note, /^Meta counts account currency minor units .*are converted/);
      else assert.doesNotMatch(note, /has no documented unit|لا توجد وحدة موثقة/);
    }
    // Without the capture, Meta is not offered in currency and health says so.
    setMetaCurrencyOffsetsForTest(null);
    const without = ownerOperations(s, {action: 'health'}, owner);
    assert.equal(without.meta_currency_offsets, 'not_pinned');
    assert.equal(without.budget_units[meta], undefined);
    assert.equal(without.meta_currency_source, undefined);
  } finally {
    setMetaCurrencyOffsetsForTest(undefined);
    s.close();
  }
});
