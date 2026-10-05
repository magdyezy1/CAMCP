import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectPortfolioFailures, localeProblems} from '../tools/check-locales.mjs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {portfolioRefusalFixture} from './fixtures/portfolio-refusal-data.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
const counts = {
    'src/portfolio.ts': 1,
    'src/google-portfolio.ts': 25,
    'src/meta-portfolio.ts': 24,
    'src/linkedin-portfolio.ts': 23,
    'src/snapchat-portfolio.ts': 24,
    'src/tiktok-portfolio.ts': 18,
    'src/x-portfolio.ts': 20,
  },
  catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  owned = new Set(
    Object.keys(counts).flatMap(file => [...inspectPortfolioFailures(fs.readFileSync(file, 'utf8'), file)]),
  );
test('all seven portfolio sources have complete authored diagnostic coverage and preserved protocol labels', () => {
  for (const [file, count] of Object.entries(counts))
    assert.equal(inspectPortfolioFailures(fs.readFileSync(file, 'utf8'), file).size, count, file);
  assert.equal(owned.size, 131);
  assert.deepEqual(localeProblems(catalog, owned), []);
  for (const message of owned) {
    assert.match(catalog[message], /[\u0600-\u06ff]/);
    for (const quantity of new Set(message.match(/\b\d[\d,]*\b/g) ?? []))
      assert.ok(catalog[message].includes(quantity), 'Missing declared quantity ' + quantity);
    for (const token of new Set(message.match(/\b(?:int64|URN|UUID|[a-z]+_[a-z_]+)\b/g) ?? []))
      assert.ok(catalog[message].includes(token), 'Missing protocol token ' + token);
  }
  for (const [message, tokens] of [
    ['For Google choose campaign, ad_group or ad.', ['campaign', 'ad_group', 'ad']],
    ['For Meta choose campaign, adset or ad.', ['campaign', 'adset', 'ad']],
    ['For LinkedIn choose campaign_group, campaign or creative.', ['campaign_group', 'campaign', 'creative']],
    ['For Snapchat choose campaign, adsquad or ad.', ['campaign', 'adsquad', 'ad']],
    ['For TikTok choose campaign, adgroup or ad.', ['campaign', 'adgroup', 'ad']],
    ['For X choose campaign, line_item or promoted_tweet.', ['campaign', 'line_item', 'promoted_tweet']],
  ])
    for (const token of tokens) assert.ok(catalog[message].includes(token), 'Missing original selector ' + token);
});
test('portfolio source ownership excludes provider values, dynamic fallbacks, member calls and other files', () => {
  const source =
    "bad('Owned portfolio sentence.');invalid('Owned portfolio refusal.');bad(native);bad(native ?? 'Fallback native diagnostic.');bad('prefix ' + native);transport.bad('Native provider message.');const labels={name:'Native name',id:'9007199254740993'};new MirrorError('NATIVE_CODE','Native diagnostic.');";
  const expected = ['Owned portfolio refusal.', 'Owned portfolio sentence.'];
  assert.deepEqual([...inspectPortfolioFailures(source, 'src/google-portfolio.ts')].sort(), expected);
  assert.deepEqual([...inspectPortfolioFailures(source, 'src\\google-portfolio.ts')].sort(), expected);
  assert.deepEqual([...inspectPortfolioFailures(source, 'src/portfolio.ts')], ['Owned portfolio sentence.']);
  assert.deepEqual([...inspectPortfolioFailures(source, 'src/native-other.ts')], []);
  assert.deepEqual(
    localeProblems(catalog, inspectPortfolioFailures(source, 'src/google-portfolio.ts')),
    expected.map(m => 'Missing Arabic message: ' + m).reverse(),
  );
});
for (const locale of ['en', 'ar'])
  test(
    'actual ' +
      locale +
      ' formatter translates owned portfolio copy while retaining envelopes, hints, references and native values',
    () => {
      const f = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
            new MirrorError('PORTFOLIO_INVALID_RESPONSE', message, {
              native_id: '9007199254740993',
              amount: '0012.34',
              currency: 'SAR',
              state: 'UNKNOWN',
              native_name: 'Native <img> name',
            }),
            'synthetic-portfolio-reference',
            0,
          ),
          before = JSON.stringify(result);
        f.context.response = result;
        f.context.error = f.run('requestError(response)');
        const text = f.run('errorMessage(error)');
        assert.ok(text.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(text.includes('synthetic-portfolio-reference'));
        assert.equal(f.context.error.message, message);
        assert.equal(f.context.error.code, 'PORTFOLIO_INVALID_RESPONSE');
        assert.equal(f.context.error.details, result.error.details);
        assert.equal(JSON.stringify(result), before);
        const hint = result.error.next_action;
        if (typeof hint === 'string') assert.ok(text.includes(locale === 'ar' ? (catalog[hint] ?? hint) : hint));
      }
      for (const message of ['Native <img> diagnostic 00123', 'FUTURE_PROVIDER_REASON', 'المعرّف الأصلي 00123', '']) {
        f.context.response = errorResult(
          new MirrorError('NATIVE_CODE', message, {native_id: '9007199254740993'}),
          'native-reference',
          0,
        );
        f.context.error = f.run('requestError(response)');
        const original = JSON.stringify(f.context.response),
          text = f.run('errorMessage(error)');
        assert.ok(text.includes(message));
        assert.equal(f.context.error.message, message);
        assert.equal(JSON.stringify(f.context.response), original);
      }
    },
  );
for (const provider of ['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x'])
  test(
    'actual ' + provider + ' inventory collector retains its original refusal through both language formatters',
    async () => {
      const f = portfolioRefusalFixture(provider);
      try {
        const input = JSON.stringify(f.input),
          result = await f.service.call('amcp_workspace', f.input, f.actor);
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.error.code, f.code);
        assert.equal(result.error.message, f.message);
        assert.equal(result.data, undefined);
        assert.equal(f.requests.length, 1);
        assert.equal(JSON.stringify(f.input), input);
        assert.equal(f.store.documents(f.actor.tenantId, 'decision_report').length, 0);
        assert.equal(f.store.documents(f.actor.tenantId, 'campaign_plan').length, 0);
        assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
        const before = JSON.stringify(result);
        for (const locale of ['en', 'ar']) {
          const ui = accountWorkflowFixture(locale);
          ui.context.response = result;
          ui.context.error = ui.run('requestError(response)');
          const text = ui.run('errorMessage(error)');
          assert.ok(text.includes(locale === 'ar' ? catalog[f.message] : f.message));
          assert.ok(text.includes(result.meta.requestId));
          assert.equal(ui.context.error.message, f.message);
          assert.equal(JSON.stringify(result), before);
        }
        assert.equal(f.requests.length, 1);
      } finally {
        f.close();
      }
    },
  );
