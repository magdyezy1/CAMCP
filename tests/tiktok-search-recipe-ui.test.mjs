// R2.5 M4, package r25-m4-search (stage 1): the guided TikTok Search pack in the website's recipe composer, in English and Arabic. The
// page groups the pack under search (its ID ends in _traffic), labels its two new dependencies on the recipe page and the capability
// center, reads its keywords one per line as MATCH_TYPE: keyword (the shape the form and a playbook's defaults hold, which the compile
// accepts beside the record), shows a brief saved through MCP with its keyword records as lines, shows no paused-launch preview of its
// own, and every sentence of the pack a person reads has Arabic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeObjective} from '../dist/src/recipe-context.js';
import {tiktokSearchContext, tiktokSearchDependencyEvidence} from '../dist/src/tiktok-search-recipe.js';
import {recipeComposerFixture as fixture} from './fixtures/recipe-composer-ui.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  business = examples.tiktok_search_business,
  definition = JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === 'tiktok_search_traffic')));
const arabic = /[؀-ۿ]/u;
// The count under the keywords box, and the refusal of a longer list (the compile's own sentence, which has its Arabic).
const countSentence = '{count} of {limit} keywords',
  serverRefusal = 'Use 1 to 1,000 keywords, each with a keyword and a match type.';

/** localization.js, workspace.js and capability-center.js in a page (tests/status-labels.test.mjs builds its page the same way). */
function capabilityPage() {
  const context = createContext({
    URL,
    Map,
    Set,
    Intl,
    content: {innerHTML: ''},
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    esc: value => String(value ?? ''),
    date: value => String(value),
    workHome: () => '',
    workspaceBind() {},
    navigationGeneration: 1,
    identityGeneration: 1,
  });
  const run = source => new Script(source).runInContext(context);
  for (const file of ['localization', 'workspace', 'capability-center'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  return {run};
}

test('the page groups every recipe as the server does, and the Search pack, whose ID ends in _traffic, under search', () => {
  const f = fixture('en', definition, business);
  for (const {id} of campaignRecipes)
    assert.equal(f.run('recipeObjectiveOf(' + JSON.stringify(id) + ')'), recipeObjective(id), id);
  assert.equal(f.run("recipeObjectiveOf('tiktok_search_traffic')"), 'search');
  assert.equal(f.run("recipeObjectiveOf('tiktok_website_traffic')"), 'traffic', 'the traffic pack is still traffic');
});

for (const locale of ['en', 'ar']) {
  test(
    'Search ' +
      locale +
      ' brief reads its keywords one per line as MATCH_TYPE: keyword and compiles them to the ad group',
    async () => {
      const f = fixture(locale, definition, business);
      await f.mount();
      const fields = f.node('#recipe-fields').innerHTML;
      assert.match(
        fields,
        locale === 'ar'
          ? /كلمات البحث الرئيسية في تيك توك — كلمة في كل سطر بصيغة MATCH_TYPE/
          : /TikTok Search keywords — one per line, as MATCH_TYPE: keyword \(PRECISE_WORD, PHRASE_WORD or BROAD_WORD\)/,
      );
      assert.doesNotMatch(
        fields,
        /Exact-match keywords|ذات المطابقة التامة/,
        'the label of the other workflows is not shown',
      );
      assert.match(fields, /<textarea name="keywords" required/);
      // The field of another workflow keeps its own label.
      assert.equal(f.run("recipeFieldLabel('keywords', 'microsoft_search')"), 'Exact-match keywords — one per line');
      f.form.values.keywords =
        'PHRASE_WORD: running shoes\n PRECISE_WORD :  trail running shoes \nBROAD_WORD: shoes: size 10\n\n';
      f.form.values.start_time_local = '2026-12-01T10:00';
      f.form.values.schedule_timezone = 'Asia/Riyadh';
      const read = f.run("readRecipeBusiness($('#recipe-form'))");
      assert.deepEqual(
        [...read.keywords],
        ['PHRASE_WORD: running shoes', 'PRECISE_WORD :  trail running shoes', 'BROAD_WORD: shoes: size 10'],
      );
      // What the form reads compiles to the ad group's keyword records.
      const plan = campaignRecipe('tiktok_search_traffic', {...business, ...read});
      // (The page's lists come from another realm: spread, as the other composer tests do.)
      assert.deepEqual(
        [...plan.steps[1].arguments.payload.search_keywords],
        [
          {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
          {keyword: 'trail running shoes', match_type: 'PRECISE_WORD'},
          {keyword: 'shoes: size 10', match_type: 'BROAD_WORD'},
        ],
      );
      assert.equal(plan.steps[1].arguments.payload.schedule_start_time, '2026-12-01 07:00:00');
    },
  );

  test('Search ' + locale + ' form shows the keyword records of a brief saved through MCP as lines', async () => {
    const f = fixture(locale, definition, business, {}, {context: {defaults: {keywords: business.keywords}}});
    await f.mount();
    const fields = f.node('#recipe-fields').innerHTML;
    assert.match(
      fields,
      /<textarea name="keywords" required rows="8" aria-describedby="recipe-keyword-count">PHRASE_WORD: running shoes\nPRECISE_WORD: trail running shoes\nBROAD_WORD: shoes<\/textarea>/,
    );
    assert.doesNotMatch(fields, /\[object Object\]/);
    // Every other item is written as a list field always wrote it: a missing item is an empty line.
    assert.match(
      f.run("recipeField('location_ids', ['6252001', null, '102358'], false, 'tiktok_search_traffic')"),
      />6252001\n\n102358<\/textarea>/,
    );
  });

  // The lead's review S3-4: the box held 6,000 characters, about 220 keywords at one line each, and a browser cuts a longer paste at the limit
  // without a word, possibly in the middle of a keyword (a real, different keyword). The field has no length limit now, the note under it
  // counts the lines, and a list over the 1,000 the pack takes is refused where the person reads it.
  test(
    'Search ' + locale + ' keywords box holds 1,000 keywords, counts them, and refuses a longer list visibly',
    async () => {
      const f = fixture(locale, definition, business);
      const lines = n =>
        Array.from(
          {length: n},
          (_, i) => ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'][i % 3] + ': keyword number ' + i,
        );
      const field = n =>
        f.run('recipeField("keywords", ' + JSON.stringify(lines(n)) + ', true, "tiktok_search_traffic")');
      const template = locale === 'ar' ? catalog[countSentence] : countSentence;
      const note = n =>
        template
          .replace('{count}', new Intl.NumberFormat(locale).format(n))
          .replace('{limit}', new Intl.NumberFormat(locale).format(1000));
      const refusal = locale === 'ar' ? catalog[serverRefusal] : serverRefusal;
      assert.match(catalog[countSentence], arabic, 'the count has Arabic');
      assert.match(catalog[serverRefusal], arabic, 'the refusal has Arabic');
      for (const n of [0, 3, 220, 221, 1000]) {
        const html = field(n);
        // Nothing is cut: no length limit on the field, and every line is in it.
        assert.doesNotMatch(html, /maxlength/, n + ' lines');
        assert.equal(html.split('keyword number').length - 1, n, n + ' lines are in the field');
        assert.ok(html.includes('>' + note(n) + '</small>'), n + ' lines: ' + html.slice(-160));
        assert.equal(html.includes(refusal), false, n + ' lines are within the limit');
      }
      // Blank lines and spaces around a line are not keywords, as readRecipeBusiness reads them.
      assert.equal(f.run('recipeKeywordNote(" a \\n\\n  \\r\\nb")'), note(2));
      // 1,000 lines survive the form's own reading, and compile to the 1,000 keywords the ad group takes.
      f.form.values.keywords = lines(1000).join('\n');
      f.form.values.start_time_local = '2026-12-01T10:00';
      f.form.values.schedule_timezone = 'Asia/Riyadh';
      const read = f.run("readRecipeBusiness($('#recipe-form'))");
      assert.equal(read.keywords.length, 1000);
      assert.equal(
        campaignRecipe('tiktok_search_traffic', {...business, ...read}).steps[1].arguments.payload.search_keywords
          .length,
        1000,
      );
      // 1,001 lines are refused in the note, in the page's language, and are never cut to fit.
      const over = field(1001);
      assert.ok(over.includes(note(1001) + ' ' + refusal), over.slice(-300));
      assert.equal(over.split('keyword number').length - 1, 1001, 'the 1,001 lines are all in the field');
      // The note follows what is typed or pasted, on the page's own listener of the field.
      const heard = [],
        shown = f.node('#recipe-keyword-count');
      f.form.elements = new Proxy(
        {},
        {
          get: (_, key) => ({
            value: '',
            addEventListener: (type, fn) => heard.push([key, type, fn]),
            setAttribute() {},
            focus() {},
          }),
        },
      );
      await f.mount();
      const input = heard.find(([key, type]) => key === 'keywords' && type === 'input');
      assert.ok(input, 'the keywords field listens to what is typed');
      input[2]({target: {value: lines(1001).join('\n')}});
      assert.equal(shown.textContent, note(1001) + ' ' + refusal);
      input[2]({target: {value: lines(5).join('\n')}});
      assert.equal(shown.textContent, note(5));
      // The other workflows' keyword box is as it was: its own limit, and no count.
      const other = f.run('recipeField("keywords", ["a", "b"], true, "microsoft_search")');
      assert.match(other, /<textarea name="keywords" required rows="3" maxlength="6000">a\nb<\/textarea><\/label>$/);
    },
  );
}

test('the preview of a Search plan is the compiled record, never the paused TikTok traffic or purchases preview', async () => {
  const f = fixture('en', definition, business);
  await f.mount();
  const {recipe, ...plan} = campaignRecipe('tiktok_search_traffic', business);
  f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
  const html = f.run('conversionRecipePreview(preview)');
  assert.doesNotMatch(html, /<h3>|Paused TikTok/);
  assert.match(html, /tiktok_search_traffic/, 'the compiled plan is shown whole');
});

test('the two dependencies of the pack have a label on the recipe page and on the capability center, each with Arabic', () => {
  const ids = ['search_keywords', 'search_ads_allowlist'],
    recipePage = fixture('en', definition, business),
    center = capabilityPage();
  for (const id of ids) assert.ok(recipeDependencies.tiktok_search_traffic.objects.includes(id), id);
  // Every object the pack declares is labelled on both pages, and the two new ones are translated.
  for (const id of recipeDependencies.tiktok_search_traffic.objects) {
    assert.ok(recipePage.run('recipeDependencyLabels.' + id), 'the recipe page labels ' + id);
    assert.ok(center.run('capabilityLabels.' + id), 'the capability center labels ' + id);
  }
  for (const id of ids) {
    const label = recipePage.run('recipeDependencyLabels.' + id);
    assert.equal(center.run('capabilityLabels.' + id), label, id);
    assert.match(catalog[label], arabic, label);
  }
});

test('every sentence of the Search pack a person reads has Arabic: its name, description, limitations, effects, evidence and refusals', () => {
  const sentences = [
    definition.name,
    definition.description,
    ...tiktokSearchContext.limitations,
    recipeDependencies.tiktok_search_traffic.effects,
    tiktokSearchDependencyEvidence('search_ads_allowlist', {}).meaning,
  ];
  const refusal = patch => {
    try {
      campaignRecipe('tiktok_search_traffic', {...business, ...patch});
    } catch (e) {
      return e.message;
    }
    assert.fail('the brief was accepted: ' + JSON.stringify(patch));
  };
  const word = (keyword, match_type = 'BROAD_WORD') => ({keyword, match_type});
  sentences.push(
    refusal({keywords: []}),
    refusal({keywords: ['shoes']}),
    refusal({keywords: [word('  ')]}),
    refusal({keywords: [word('shoes', 'EXACT')]}),
    refusal({keywords: [word('shoes'), word('shoes')]}),
    refusal({keywords: [word('shoes\nsandals')]}),
    refusal({pixel_id: '8800'}),
  );
  assert.equal(new Set(sentences).size, sentences.length, 'each is its own sentence');
  for (const sentence of sentences) assert.match(catalog[sentence] ?? '', arabic, sentence);
});
