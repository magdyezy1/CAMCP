import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {checkWebLocales, inspectJournalSentences, localeProblems} from '../tools/check-locales.mjs';
import {operationRecovery} from '../dist/src/operation-journal.js';

/**
 * r25-field3-errors, the lead review of 2026-11-21 (deviation 2): the media recovery page prints the operation journal's `next_safe_action` as the
 * server sent it, so every sentence of src/operation-journal.ts needs its Arabic, not only the two this package added (not_claimed and
 * validation_rejected; parts_claimed followed). The sentences are written in that one table and are display copy: the gate reads them from the
 * source, so a phase added without its Arabic fails `node tools/check-locales.mjs`.
 */
const catalog = JSON.parse(fs.readFileSync(new URL('../web/locales/ar.json', import.meta.url), 'utf8')),
  source = fs.readFileSync(new URL('../src/operation-journal.ts', import.meta.url), 'utf8'),
  web = fs.readFileSync(new URL('../web/workspace.js', import.meta.url), 'utf8'),
  phases = [
    'claimed',
    'allocated',
    'transferring',
    'responded',
    'uncertain',
    'not_sent',
    'rejected',
    'not_claimed',
    'validation_rejected',
    'parts_claimed',
    'collecting',
    'delivering',
    'delivered',
    'failed',
  ],
  sentences = inspectJournalSentences(source);

test('every recovery sentence of the operation journal, and the one for a phase it lacks, is read from the source and has Arabic', () => {
  assert.equal(sentences.size, phases.length + 1);
  for (const phase of phases) assert.ok(sentences.has(operationRecovery(phase).next_safe_action), phase);
  assert.ok(sentences.has(operationRecovery('a_phase_the_table_lacks').next_safe_action));
  assert.deepEqual(localeProblems(catalog, sentences), []);
  for (const sentence of sentences) {
    assert.match(catalog[sentence], /[؀-ۿ]/, sentence);
    assert.notEqual(catalog[sentence], sentence);
    // Native tool, action, field and code names stay exactly as the server writes them.
    for (const name of ['amcp_write status', 'amcp_media recovery', 'provider_errors', 'CMP-04'])
      if (sentence.includes(name)) assert.ok(catalog[sentence].includes(name), name + ' in: ' + sentence);
  }
});

test('the gate requires them, and a sentence added without its Arabic is a missing message', () => {
  const result = checkWebLocales();
  assert.deepEqual(result.problems, []);
  assert.deepEqual([...(result.sources.get('server:operation-journal') ?? [])].sort(), [...sentences].sort());
  const sentence = 'A phase sentence added to the journal without its Arabic.',
    added = inspectJournalSentences(source + '\nconst more = ' + JSON.stringify(sentence) + ';\n');
  assert.ok(added.has(sentence));
  assert.deepEqual(localeProblems(catalog, added), ['Missing Arabic message: ' + sentence]);
});

test('the media recovery page says the journal sentence through the catalog, and keeps its own fallback', () => {
  assert.ok(web.includes('uiText(r.journal.next_safe_action)'), 'the sentence goes through the catalog');
  assert.doesNotMatch(web, /r\.journal\.next_safe_action\s*\?\?/, 'the server’s sentence is not printed as it came');
  assert.ok(web.includes('Inspect the retained request and receipt. Unknown submissions must not be repeated.'));
});
