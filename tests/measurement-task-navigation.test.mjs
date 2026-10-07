import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {
  conversionMetadataFixture,
  conversionMetadataConnectionId,
} from './fixtures/linkedin-conversion-metadata-data.mjs';

const plain = value => JSON.parse(JSON.stringify(value)),
  sections = ['gtm', 'events', 'identity', 'conversions', 'trace'],
  headings = ['measurement-task-heading', ...sections.map(id => 'measurement-section-' + id)],
  links = sections.flatMap(id => [
    ['measurement-task-link-' + id, 'measurement-section-' + id],
    ['measurement-section-' + id + '-return', 'measurement-task-heading'],
  ]);
function setup(locale) {
  const f = accountWorkflowFixture(locale),
    focuses = [],
    scrolls = [];
  f.context.platforms.find(p => p.id === 'linkedin').connections[0].id = conversionMetadataConnectionId;
  for (const id of headings) {
    const heading = f.node('#' + id);
    heading.focus = options => {
      focuses.push({id, options: plain(options)});
    };
    heading.scrollIntoView = options => {
      scrolls.push({id, options: plain(options)});
    };
  }
  for (const [id, target] of links) f.node('#' + id).setAttribute('href', '#' + target);
  return {...f, focuses, scrolls};
}
function click(f, id, changes = {}) {
  const link = f.node('#' + id);
  let prevented = 0;
  const event = {
    currentTarget: link,
    defaultPrevented: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => {
      prevented++;
    },
    ...changes,
  };
  link.events.get('click')(event);
  return prevented;
}
function fields(f) {
  return plain(
    ['measurement-audit', 'measurement-events', 'measurement-event-identity', 'measurement-conversions'].map(id => [
      id,
      Object.fromEntries(Object.entries(f.node('#' + id).elements).map(([name, node]) => [name, node.value])),
    ]),
  );
}
for (const locale of ['en', 'ar']) {
  test(
    locale +
      ' local measurement jumps preserve a pending original native read, every draft and the completed local search',
    {timeout: 15000},
    async t => {
      const native = conversionMetadataFixture('owned');
      t.after(native.close);
      const f = setup(locale);
      let release, readyResolve, readyReject;
      const held = new Promise(resolve => {
          release = resolve;
        }),
        ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
      void ready.catch(() => {});
      f.respond(async args => {
        let response;
        try {
          assert.deepEqual(plain(args), native.input);
          response = await native.call();
          assert.equal(response.success, true, JSON.stringify(response));
        } catch (error) {
          readyReject(error);
          throw error;
        }
        readyResolve(response.data);
        await held;
        return plain(response.data);
      });
      await f.run('renderMeasurement()');
      const originalFields = fields(f),
        pending = f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions'));
      void pending.catch(() => {});
      let observed;
      try {
        observed = await ready;
        assert.equal(native.requests.length, 3);
        assert.equal(f.calls.length, 1);
        for (const [id, target] of links) {
          assert.equal(click(f, id), 1);
          assert.deepEqual(f.focuses.at(-1), {id: target, options: {preventScroll: true}});
          assert.deepEqual(f.scrolls.at(-1), {id: target, options: {block: 'start'}});
          assert.deepEqual(fields(f), originalFields);
          assert.equal(f.node('#measurement-conversions-result').innerHTML, '');
        }
        assert.equal(native.requests.length, 3);
        assert.equal(f.calls.length, 1);
      } finally {
        release();
      }
      await pending;
      const search = f.node('#conversion-rule-search');
      search.value = 'insight_tag';
      search.events.get('input')();
      const originalResult = f.node('#measurement-conversions-result').innerHTML,
        originalRows = f.node('#conversion-rule-rows').innerHTML;
      assert.match(originalRows, /INSIGHT_TAG/);
      assert.equal(observed.rules[0].id, '9007199254740993');
      assert.equal(observed.rules[0].value.amount, '9007199254740993.123456789');
      for (const key of ['event_delivery', 'deduplication', 'consent', 'historical_attribution'])
        assert.equal(observed.checks[key], 'unverified');
      for (const [id] of links) assert.equal(click(f, id), 1);
      assert.equal(f.node('#measurement-conversions-result').innerHTML, originalResult);
      assert.equal(f.node('#conversion-rule-rows').innerHTML, originalRows);
      assert.equal(search.value, 'insight_tag');
      assert.deepEqual(fields(f), originalFields);
      assert.deepEqual(f.calls, [native.input]);
      assert.equal(native.requests.length, 3);
      assert.equal(native.store.documents(native.actor.tenantId, 'decision_report').length, 0);
    },
  );
  test(
    locale +
      ' measurement jump callbacks leave modified links, changed targets and departed view or identity untouched',
    async () => {
      const cases = [
        ['defaultPrevented', f => ({defaultPrevented: true})],
        ['other mouse button', f => ({button: 1})],
        ...['ctrlKey', 'metaKey', 'shiftKey', 'altKey'].map(key => [key, f => ({[key]: true})]),
        ['other current target', f => ({currentTarget: f.node('#measurement-task-link-events')})],
        [
          'download',
          f => {
            f.node('#measurement-task-link-gtm').setAttribute('download', '');
            return {};
          },
        ],
        [
          'other browsing target',
          f => {
            f.node('#measurement-task-link-gtm').setAttribute('target', '_blank');
            return {};
          },
        ],
        [
          'changed fragment',
          f => {
            f.node('#measurement-task-link-gtm').setAttribute('href', '#measurement-section-events');
            return {};
          },
        ],
        [
          'detached link',
          f => {
            f.node('#measurement-task-link-gtm').isConnected = false;
            return {};
          },
        ],
        [
          'detached heading',
          f => {
            f.node('#measurement-section-gtm').isConnected = false;
            return {};
          },
        ],
        [
          'detached navigation',
          f => {
            f.node('#measurement-task-navigation').isConnected = false;
            return {};
          },
        ],
        [
          'departed view',
          f => {
            f.context.navigationGeneration++;
            return {};
          },
        ],
        [
          'departed identity',
          f => {
            f.context.identityGeneration++;
            return {};
          },
        ],
      ];
      for (const [reason, change] of cases) {
        const f = setup(locale);
        await f.run('renderMeasurement()');
        const original = fields(f),
          override = change(f);
        assert.equal(click(f, 'measurement-task-link-gtm', override), 0, reason);
        assert.deepEqual(f.focuses, [], reason);
        assert.deepEqual(f.scrolls, [], reason);
        assert.deepEqual(fields(f), original, reason);
        assert.equal(f.calls.length, 0, reason);
      }
      const f = setup(locale);
      await f.run('renderMeasurement()');
      const oldLink = f.node('#measurement-task-link-gtm'),
        oldHandler = oldLink.events.get('click');
      f.context.navigationGeneration++;
      await f.run('renderMeasurement()');
      let prevented = 0;
      oldHandler({
        currentTarget: oldLink,
        button: 0,
        preventDefault: () => {
          prevented++;
        },
      });
      assert.equal(prevented, 0);
      assert.equal(f.focuses.length, 0);
      assert.equal(click(f, 'measurement-task-link-gtm'), 1);
      assert.equal(f.focuses.at(-1).id, 'measurement-section-gtm');
      assert.equal(f.calls.length, 0);
    },
  );
  test(
    locale +
      ' only six exact measurement fragments receive initial focus and original handoff selection never reads automatically',
    async () => {
      const query = '?conversion_rules=1&connection_id=' + conversionMetadataConnectionId + '&account_id=100';
      for (const target of headings) {
        const f = setup(locale);
        f.context.location.search = query;
        f.context.location.hash = '#' + target;
        await f.run('renderMeasurement()');
        assert.deepEqual(f.focuses, [{id: target, options: {preventScroll: true}}]);
        assert.deepEqual(f.scrolls, [{id: target, options: {block: 'start'}}]);
        assert.equal(f.node('#measurement-conversions').elements.target.value, '0');
        assert.equal(f.context.location.search, query);
        assert.equal(f.calls.length, 0);
      }
      for (const fragment of [
        '',
        '#unknown',
        '#measurement-section-gtm%00',
        '#measurement-section-gtm?account_id=999',
        '##measurement-section-gtm',
        '#measurement-task-heading-return',
      ]) {
        const f = setup(locale);
        f.context.location.search = query;
        f.context.location.hash = fragment;
        await f.run('renderMeasurement()');
        assert.deepEqual(f.focuses, [], fragment);
        assert.deepEqual(f.scrolls, [], fragment);
        assert.equal(f.node('#measurement-conversions').elements.target.value, '0', fragment);
        assert.equal(f.context.location.search, query, fragment);
        assert.equal(f.calls.length, 0, fragment);
      }
    },
  );
}
