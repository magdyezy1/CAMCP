// MCP-03 phase 2 (review 2026-10-08): the owner health view shows the AI-client registrations of the last 24 hours
// against the per-address and daily registration limits, and an alarm near a limit, in English and Arabic. Counts only:
// no client, address or token reaches the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const controller = readFileSync('web/owner-operations.js', 'utf8');
const helper = controller.slice(
  controller.indexOf('function ownerMcpClients('),
  controller.indexOf('// WRT-05: what the owner sees'),
);

function render(locale, value) {
  const context = createContext({
    Intl,
    document: {addEventListener() {}},
    renderSettings: () => {},
    esc: text =>
      String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(helper);
  context.value = value;
  return run('ownerMcpClients(value)');
}

const capacity = {
  registered: 4012,
  limit: 5000,
  headroom: 988,
  releasable_on_next_registration: 3,
  registered_last_24h: 245,
  daily_limit: 300,
  per_address_daily_limit: 30,
  alarms: ['daily_registrations'],
};

test('owner health shows registrations against the daily and per-address limits, with an alarm near a limit', () => {
  assert.ok(helper.startsWith('function ownerMcpClients('), 'the helper is found');
  const en = render('en', capacity);
  assert.match(en, /AI client registrations: 4,012 of 5,000\. 988 free; 3 can be released at the next registration\./);
  assert.match(en, /New registrations in the last 24 hours: 245 of 300; at most 30 from one network address\./);
  assert.match(en, /<p class="notice" id="owner-mcp-clients-alarm" role="status">AI client registrations are close/);
  const ar = render('ar', capacity);
  assert.match(ar, /تسجيلات عملاء الذكاء الاصطناعي: 4,012 من 5,000/);
  assert.match(ar, /التسجيلات الجديدة خلال آخر 24 ساعة: 245 من 300؛ وبحد أقصى 30 من عنوان شبكة واحد\./);
  assert.match(ar, /role="status">اقتربت تسجيلات عملاء الذكاء الاصطناعي من أحد الحدود/);
  for (const html of [en, ar])
    assert.doesNotMatch(html, /AI client registrations are close.*AI client registrations are close/s);
});

test('owner health shows no alarm below the limits, and an older health answer without limits keeps the count alone', () => {
  const calm = render('en', {...capacity, alarms: []});
  assert.match(calm, /New registrations in the last 24 hours: 245 of 300/);
  assert.doesNotMatch(calm, /owner-mcp-clients-alarm/);
  const older = render('en', {registered: 2, limit: 1000, headroom: 998, releasable_on_next_registration: 0});
  assert.match(older, /AI client registrations: 2 of 1,000\. 998 free; 0 can be released/);
  assert.doesNotMatch(older, /New registrations|owner-mcp-clients-alarm|undefined/);
  // A malformed count reads as unknown rather than as a number the owner could act on.
  assert.match(render('en', {...capacity, registered_last_24h: 'many'}), /in the last 24 hours: Unknown of 300/);
});
