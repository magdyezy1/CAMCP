// F-LEAD-01: amcp_reporting_overview's own description is a short routing description, as the other first-party tools'
// are. Every statement it makes is checked below against the code it describes, and the detail it used to carry (most of
// it the v3 requirements bootstrap now publishes per platform) is served by the action help and the reporting guide.
import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewTool, overviewPollAfterMs} from '../dist/src/reporting-overview.js';
import {descriptionBudget} from '../dist/src/tool-summaries.js';
import {actionArgumentFindings, firstPartyContract} from '../dist/src/first-party-contracts.js';
import {ownToolHelp} from '../dist/src/tool-help.js';
import {savePresentation, applyProfilePresentation} from '../dist/src/report-packs.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const tool = 'amcp_reporting_overview';
const text = overviewTool.description;
function fixture(t) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  return {...f, call: args => f.service.call(tool, args, f.actor)};
}

test('the description is a routing description within the description budget, with the detail left to help and the guide', () => {
  assert.ok(text.length <= descriptionBudget, 'description is ' + text.length + ' characters');
  assert.match(text, /^Use this for saved client reports/);
  assert.match(text, /to analyse one captured native report, use amcp_reporting\b/);
  assert.match(text, /platforms\[\]\.reporting_v4/);
  assert.match(text, /platforms\[\]\.entity_levels/);
  assert.ok(text.includes('action:"help"') && text.includes('topic:<action>'));
  assert.ok(text.includes('amcp_workspace {action:"help",topic:"guides/reporting-overview"}'));
});

test('the description states no per-platform requirement that a v4 source no longer has', () => {
  // These were true of the v3 configuration only. A v4 source takes its levels, option names and defaults from
  // bootstrap platforms[].reporting_v4 (tests/overview-v4-contract.test.mjs pins the defaults), so a description that
  // still requires them sends a client to supply values the server fills in, or away from a call the server accepts.
  for (const stale of [
    /Detailed sources require/i,
    /report_options\s*:\s*\{/,
    /result_action_type/,
    /swipe_up_attribution_window|view_attribution_window/,
    /exact campaign_id/,
    /1–31 closed days/,
    /each source optionally sets level/i,
    /Existing campaign configurations keep their original shape/,
    /Qualified detail supports/,
  ])
    assert.doesNotMatch(text, stale);
});

test('what the description says bootstrap lists is what bootstrap returns', async t => {
  const f = fixture(t),
    boot = await f.call({action: 'bootstrap'});
  assert.equal(boot.success, true, JSON.stringify(boot.error));
  assert.ok(boot.data.platforms.length >= 6);
  for (const platform of boot.data.platforms) {
    assert.ok(platform.entity_levels.length > 0, platform.id + ' entity_levels');
    const v4 = platform.reporting_v4;
    assert.ok(Array.isArray(v4.levels) && Array.isArray(v4.option_names), platform.id + ' levels and option names');
    assert.equal(typeof v4.defaults, 'object', platform.id + ' defaults');
  }
  for (const key of ['metrics', 'objectives', 'views', 'templates', 'schedules', 'destinations'])
    assert.ok(Object.hasOwn(boot.data, key), key);
  for (const word of ['levels', 'option names', 'defaults', 'metrics', 'objectives', 'saved reports', 'templates'])
    assert.ok(text.includes(word), 'the description says bootstrap lists ' + word);
});

test('what the description says about run, get, confirmation and revisions is what the handlers do', async t => {
  const f = fixture(t),
    config = granularConfig(granularSource('meta')),
    run = await f.call({action: 'run', config, confirmed: true});
  assert.equal(run.success, true, JSON.stringify(run.error));
  // run: an estimate, the next call and the polling interval, with no provider request.
  assert.ok(Number.isInteger(run.data.estimated_requests) && run.data.estimated_requests > 0);
  assert.deepEqual(run.data.next_call, {tool, arguments: {action: 'get', id: run.data.id, limit: 1}});
  assert.equal(run.data.poll_after_ms, overviewPollAfterMs);
  assert.equal(f.requests.length, 0);
  for (const word of ['estimated_requests', 'next_call', 'poll_after_ms']) assert.ok(text.includes(word), word);
  // get: pages of 1 to 500 rows, and the two include flags.
  assert.equal((await f.call({action: 'get', id: run.data.id, limit: 500})).success, true);
  assertRefused(await f.call({action: 'get', id: run.data.id, limit: 501}), 'INVALID_PAGE');
  assert.equal((await f.call({action: 'get', id: run.data.id, include: {native: true, lineage: true}})).success, true);
  assertRefused(await f.call({action: 'get', id: run.data.id, include: {raw: true}}), 'INVALID_REPORT');
  assert.match(text, /1–500 rows/);
  // An action that saves or runs needs confirmed:true.
  assertRefused(await f.call({action: 'run', config}), 'CONFIRMATION_REQUIRED');
  assertRefused(await f.call({action: 'save', config}), 'CONFIRMATION_REQUIRED');
  // Editing or deleting a saved report takes its expected_revision.
  const saved = await f.call({action: 'save', config, confirmed: true});
  assert.equal(saved.success, true, JSON.stringify(saved.error));
  assertRefused(await f.call({action: 'save', id: saved.data.id, config, confirmed: true}), 'REVISION_CONFLICT');
  assertRefused(await f.call({action: 'delete_view', id: saved.data.id, confirmed: true}), 'REVISION_CONFLICT');
  const edited = await f.call({
    action: 'save',
    id: saved.data.id,
    expected_revision: saved.data.revision,
    config,
    confirmed: true,
  });
  assert.equal(edited.success, true, JSON.stringify(edited.error));
  assert.match(text, /expected_revision/);
  assert.match(text, /48 hours/);
});

test('the detail the description used to carry is served by the help of the action it belongs to', () => {
  // [action, argument, phrases the argument note must contain]
  const moved = [
    ['get', 'include', [/native/, /lineage/, /compact/]],
    ['run', 'compare', [/previous_period/, /equal-length window/, /100 active reporting jobs/]],
    ['compare', 'baseline_id', [/previous-period pair/, /compare_candidates/]],
    ['resolve_delivery', 'resolution', [/check/, /settle window/, /abandon/, /conflicting marker/]],
    ['delete_report', 'resolution', [/abandon/, /unconfirmed/]],
    ['bind_file_destination', 'file_destination', [/formats/, /pdf/, /xlsx/, /no Sheets login/]],
    ['save_presentation', 'presentation_revision', [/0 when/]],
    ['apply_profile_presentation', 'profile_revision', [/exact/]],
    ['move_workbook_schedule', 'move_version', [/preview_workbook_move/]],
  ];
  for (const [action, argument, phrases] of moved) {
    const help = ownToolHelp(overviewTool, action),
      note = help.arguments?.[argument]?.description ?? '';
    for (const phrase of phrases) assert.match(note, phrase, action + ' ' + argument + ': ' + note);
  }
});

test('the contracts of the actions whose rules moved name the arguments their handlers require', async t => {
  const f = fixture(t),
    required = action => firstPartyContract(overviewTool, action).argumentsSchema.required;
  // resolve_delivery: the handler needs the Sheets destination; delivery_id only narrows it.
  assert.deepEqual(required('resolve_delivery').sort(), ['action', 'confirmed', 'destination_id', 'resolution']);
  assert.deepEqual(
    actionArgumentFindings(overviewTool, {
      action: 'resolve_delivery',
      destination_id: 'synthetic-destination',
      delivery_id: 'synthetic-delivery',
      resolution: 'check',
      confirmed: true,
    }),
    [],
  );
  assertRefused(
    await f.call({action: 'resolve_delivery', delivery_id: 'synthetic-delivery', resolution: 'check', confirmed: true}),
    'INVALID_ARGUMENT',
  );
  // get: the include flags are an argument of get; the row left them out, so a correct call drew a warning.
  assert.deepEqual(
    actionArgumentFindings(overviewTool, {
      action: 'get',
      id: 'synthetic-report',
      limit: 1,
      include: {native: true, lineage: true},
    }),
    [],
  );
  // bind_file_destination: a stable creation key.
  assert.ok(required('bind_file_destination').includes('idempotency_key'));
  assertRefused(
    await f.call({
      action: 'bind_file_destination',
      confirmed: true,
      file_destination: {name: 'Synthetic files', formats: ['pdf']},
    }),
    'INVALID_DESTINATION',
  );
  // save_presentation: the snapshot's current presentation revision, 0 for a new presentation.
  assert.ok(required('save_presentation').includes('presentation_revision'));
  assertRefused(
    (() => {
      try {
        return savePresentation(f.store, f.actor, 'synthetic-report', {confirmed: true, presentation: {}});
      } catch (error) {
        return error;
      }
    })(),
    'INVALID_ARGUMENT',
    {message: /presentation_revision/},
  );
  assert.equal(
    savePresentation(f.store, f.actor, 'synthetic-report', {
      confirmed: true,
      presentation: {},
      presentation_revision: 0,
    }).presentation_revision,
    1,
  );
  // apply_profile_presentation: the exact profile revision and the current presentation revision.
  for (const name of ['profile_id', 'profile_revision', 'presentation_revision'])
    assert.ok(required('apply_profile_presentation').includes(name), name);
  assertRefused(
    (() => {
      try {
        return applyProfilePresentation(
          f.store,
          f.actor,
          {id: 'synthetic-report'},
          {confirmed: true, profile_id: 'synthetic-profile', presentation_revision: 0},
        );
      } catch (error) {
        return error;
      }
    })(),
    'INVALID_ARGUMENT',
    {message: /profile_revision/},
  );
});
