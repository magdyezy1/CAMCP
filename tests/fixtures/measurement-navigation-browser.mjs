import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function exerciseMeasurementNavigation(page, site, options) {
  const {output, id, locale, width, mode, before, beforeEvidence, result} = options,
    catalog = JSON.parse(fs.readFileSync(options.catalogPath ?? 'web/locales/ar.json', 'utf8')),
    translated = text => (locale === 'ar' ? catalog[text] : text),
    sectionIds = ['gtm', 'events', 'identity', 'conversions'],
    headingIds = ['measurement-task-heading', ...sectionIds.map(value => 'measurement-section-' + value)],
    formIds = ['measurement-audit', 'measurement-events', 'measurement-event-identity', 'measurement-conversions'],
    input = site.measurementNavigation.input,
    endpoint = site.origin + '/api/workspace/workspace',
    toolRequests = [];
  const onRequest = request => {
    if (request.url() === endpoint) toolRequests.push(request.postDataJSON());
  };
  page.on('request', onRequest);
  const currentCounts = () => {
    assert.equal(site.counts().writes, before.writes);
    assert.equal(site.counts().refused, before.refused);
    assert.deepEqual(site.evidenceCounts(), beforeEvidence);
  };
  const visibleFocus = async target => {
    assert.equal(await page.evaluate(() => document.activeElement.id), target);
    const geometry = await page.locator('#' + target).evaluate(node => {
      const rectangle = node.getBoundingClientRect(),
        style = getComputedStyle(node),
        header = document.querySelector('.topbar'),
        headerStyle = header && getComputedStyle(header),
        obstruction =
          header && ['sticky', 'fixed'].includes(headerStyle.position)
            ? Math.max(0, header.getBoundingClientRect().bottom)
            : 0;
      return {
        top: rectangle.top,
        bottom: rectangle.bottom,
        height: innerHeight,
        outline: style.outlineStyle,
        outline_width: parseFloat(style.outlineWidth),
        obstruction,
        left: rectangle.left,
        right: rectangle.right,
        viewport_width: innerWidth,
      };
    });
    assert.ok(
      geometry.top >= geometry.obstruction + 3 && geometry.bottom <= geometry.height + 1,
      'The selected heading must be readable below the fixed or sticky header',
    );
    assert.ok(
      geometry.left >= -1 && geometry.right <= geometry.viewport_width + 1,
      'The focused heading must stay within the horizontal viewport',
    );
    assert.equal(geometry.outline, 'solid');
    assert.ok(geometry.outline_width >= 3);
  };
  const fieldSnapshot = () =>
    page.evaluate(
      ids =>
        ids.flatMap(id =>
          [...document.getElementById(id).elements]
            .filter(field => field.name)
            .map(field => ({form: id, name: field.name, value: field.value, disabled: field.disabled})),
        ),
      formIds,
    );
  try {
    if (mode === 'linked') {
      const query =
          '?conversion_rules=1&connection_id=' +
          encodeURIComponent(input.connection_id) +
          '&account_id=' +
          encodeURIComponent(input.account_id),
        known = [],
        unknown = [];
      for (const target of headingIds) {
        await page.goto(site.origin + '/measurement' + query + '#' + target, {waitUntil: 'networkidle'});
        await page.locator('#measurement-task-navigation').waitFor();
        await visibleFocus(target);
        assert.equal(new URL(page.url()).search, query);
        assert.equal(await page.locator('#measurement-conversions [name=target]').inputValue(), '0');
        assert.equal(site.counts().nativeReads, before.nativeReads);
        currentCounts();
        known.push(target);
      }
      for (const fragment of ['#not-a-measurement-task', '#measurement-section-gtm%00']) {
        await page.goto(site.origin + '/measurement' + query + fragment, {waitUntil: 'networkidle'});
        await page.locator('#measurement-task-navigation').waitFor();
        assert.equal(headingIds.includes(await page.evaluate(() => document.activeElement.id)), false);
        assert.equal(new URL(page.url()).search, query);
        assert.equal(await page.locator('#measurement-conversions [name=target]').inputValue(), '0');
        assert.equal(site.counts().nativeReads, before.nativeReads);
        currentCounts();
        unknown.push(fragment);
      }
      assert.equal(toolRequests.length, 0);
      result.measurement_navigation = {
        mode,
        known_fragments: known.length,
        ignored_unknown_fragments: unknown.length,
        query_scope_preserved: true,
        original_handoff_selection_preserved: true,
        automatic_reads: 0,
        native_reads: 0,
        provider_mutations: 0,
        saved_reports: 0,
      };
      return;
    }
    assert.equal(mode, 'local');
    const navigation = page.locator('#measurement-task-navigation');
    assert.equal(await navigation.getAttribute('aria-labelledby'), 'measurement-task-heading');
    assert.equal(await navigation.getAttribute('aria-describedby'), 'measurement-task-help');
    assert.equal(
      (await page.locator('#measurement-task-heading').innerText()).trim(),
      translated('Choose a measurement task'),
    );
    assert.equal(
      (await page.locator('#measurement-task-help').innerText()).trim(),
      translated('Jump between sections without changing your entries. Reads start only when you submit a form.'),
    );
    for (const target of ['measurement-task-heading', 'measurement-task-help']) {
      const geometry = await page.locator('#' + target).evaluate(node => {
        const box = node.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          width: innerWidth,
          client: node.clientWidth,
          scroll: node.scrollWidth,
        };
      });
      assert.ok(geometry.left >= -1 && geometry.right <= geometry.width + 1);
      assert.ok(geometry.scroll <= geometry.client + 1, 'Task title and help must wrap within their container');
    }
    assert.equal(await navigation.locator('a').count(), 4);
    assert.equal(await page.locator('.measurement-task-return').count(), 4);
    const targets = [
      'Google Tag Manager configuration audit',
      'Recent GA4 events',
      'Inspect a specific GA4 test identifier',
      'LinkedIn conversion settings',
    ];
    let contrastChecks = 0;
    for (const [index, section] of sectionIds.entries()) {
      const link = page.locator('#measurement-task-link-' + section);
      assert.equal(await link.getAttribute('href'), '#measurement-section-' + section);
      assert.equal((await link.innerText()).trim(), translated(targets[index]));
      const rectangle = await link.boundingBox();
      assert.ok(rectangle.height >= 44 && rectangle.width >= 44);
      assert.ok(rectangle.x >= -1 && rectangle.x + rectangle.width <= width + 1);
      for (const state of ['normal', 'hover']) {
        if (state === 'hover') await link.hover();
        const contrast = await link.evaluate(node => {
          const style = getComputedStyle(node);
          const luminance = text => {
            const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(text);
            if (!match) throw Error('Navigation contrast needs opaque resolved RGB colors');
            const channels = match.slice(1).map(value => {
              const channel = Number(value) / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          };
          const foreground = luminance(style.color),
            background = luminance(style.backgroundColor);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
        assert.ok(contrast >= 4.5, 'Navigation text must remain readable in ' + state + ' state');
        contrastChecks++;
        if (state === 'hover') await page.mouse.move(0, 0);
      }
    }
    const related = page
      .locator('details.workspace-details > summary')
      .filter({hasText: translated('Related measurement workflows')});
    assert.equal(await related.count(), 1);
    assert.equal(await related.evaluate(node => node.closest('details').open), false);
    await related.click();
    assert.equal(await related.evaluate(node => node.closest('details').open), true);
    assert.equal(await related.locator('..').locator('a[href="/reporting-overview"]').count(), 1);
    await related.click();
    const values = {
      'measurement-audit': {container_id: '001', workspace_id: '002'},
      'measurement-events': {event_names: 'purchase, generate_lead', minutes: '5', stream_id: '900'},
      'measurement-event-identity': {
        event_name: 'purchase',
        test_id: 'amcp-test-12345678-abcd',
        date_from: '2026-10-01',
        date_to: '2026-10-02',
        stream_id: '900',
        expected_count: '1',
      },
    };
    for (const [formId, fields] of Object.entries(values))
      for (const [name, value] of Object.entries(fields))
        await page.locator('#' + formId + ' [name=' + name + ']').fill(value);
    await page.locator('#measurement-conversions [name=target]').selectOption('0');
    const fields = await fieldSnapshot(),
      originalUrl = page.url(),
      originalHistory = await page.evaluate(() => history.length);
    assert.equal(fields.length, 15);
    let jumps = 0,
      returns = 0;
    const jump = async section => {
      const target = 'measurement-section-' + section;
      await page.locator('#measurement-task-link-' + section).focus();
      await page.keyboard.press('Enter');
      await visibleFocus(target);
      assert.deepEqual(await fieldSnapshot(), fields);
      assert.equal(page.url(), originalUrl);
      assert.equal(await page.evaluate(() => history.length), originalHistory);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), target + '-return');
      await page.keyboard.press('Enter');
      await visibleFocus('measurement-task-heading');
      assert.equal(page.url(), originalUrl);
      assert.equal(await page.evaluate(() => history.length), originalHistory);
      jumps++;
      returns++;
    };
    for (const section of sectionIds) await jump(section);
    assert.equal(site.counts().nativeReads, before.nativeReads);
    assert.equal(toolRequests.length, 0);
    currentCounts();
    await navigation.screenshot({path: path.join(output, id + '-navigation.png')});
    let releaseResponse,
      readyResolve,
      readyReject,
      completedResolve,
      completedError,
      delayStarted = false;
    const completed = new Promise(resolve => {
        completedResolve = resolve;
      }),
      held = new Promise(resolve => {
        releaseResponse = resolve;
      }),
      ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      }),
      readyTimer = setTimeout(() => readyReject(Error('The original native conversion response was not ready')), 15000);
    const delay = async intercepted => {
      delayStarted = true;
      try {
        const response = await intercepted.fetch();
        assert.equal(response.status(), 200);
        const original = await response.json();
        assert.equal(original.success, true);
        assert.equal(original.data.rule_count, 51);
        assert.deepEqual(original.data.scope, {
          gateway: input.gateway,
          connection_id: input.connection_id,
          account_id: input.account_id,
          api_version: '202609',
        });
        readyResolve(original.data);
        await held;
        await intercepted.fulfill({response});
      } catch (error) {
        completedError = error;
        readyReject(error);
        await intercepted.abort('failed').catch(() => {});
      } finally {
        completedResolve();
      }
    };
    void ready.catch(() => {});
    await page.route(endpoint, delay);
    let original;
    try {
      await page.locator('#measurement-conversions button[type=submit]').click();
      original = await ready;
      assert.equal(await page.locator('#measurement-conversions button[type=submit]').isDisabled(), true);
      assert.equal(site.counts().nativeReads - before.nativeReads, 3);
      assert.deepEqual(toolRequests, [input]);
      for (const section of sectionIds) await jump(section);
      assert.equal(await page.locator('#measurement-conversions button[type=submit]').isDisabled(), true);
      assert.equal(await page.locator('#conversion-settings-heading').count(), 0);
      currentCounts();
    } finally {
      clearTimeout(readyTimer);
      releaseResponse();
      if (delayStarted) await completed;
      await page.unroute(endpoint, delay);
      if (completedError) throw completedError;
    }
    await page.locator('#conversion-settings-heading').waitFor();
    await page.waitForFunction(() => !document.querySelector('#measurement-conversions button[type=submit]').disabled);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'conversion-settings-heading');
    assert.equal(original.rules[0].id, '9007199254740993');
    assert.equal(original.rules[0].value.amount, '9007199254740993.123456789');
    for (const key of ['event_delivery', 'deduplication', 'consent', 'historical_attribution'])
      assert.equal(original.checks[key], 'unverified');
    assert.equal(original.checks.configuration, 'observed');
    assert.equal(original.checks.campaign_membership, 'not_collected');
    assert.equal(original.advertising_writes, 0);
    assert.equal(original.retained_snapshot, false);
    const search = page.locator('#conversion-rule-search');
    await search.fill('insight_tag');
    await page.waitForFunction(() => document.querySelectorAll('#conversion-rule-rows tbody tr').length === 1);
    const resultMarkup = await page.locator('#measurement-conversions-result').innerHTML();
    assert.ok(resultMarkup.includes('INSIGHT_TAG'));
    for (const section of ['gtm', 'conversions']) await jump(section);
    assert.equal(await page.locator('#measurement-conversions-result').innerHTML(), resultMarkup);
    assert.equal(await search.inputValue(), 'insight_tag');
    assert.equal(site.counts().nativeReads - before.nativeReads, 3);
    assert.deepEqual(toolRequests, [input]);
    assert.deepEqual(await fieldSnapshot(), fields);
    currentCounts();
    result.measurement_navigation = {
      mode,
      local_task_jumps: jumps,
      return_jumps: returns,
      preserved_form_fields: fields.length,
      navigation_text_contrast_checks: contrastChecks,
      heading_clear_of_header: true,
      url_and_history_preserved: true,
      pending_original_read_preserved: true,
      original_scope_preserved: true,
      completed_result_preserved: true,
      local_result_search_preserved: true,
      exact_native_values_preserved: true,
      measurement_states_unverified: true,
      automatic_reads: 0,
      native_reads: 3,
      provider_mutations: 0,
      saved_reports: 0,
    };
  } finally {
    page.off('request', onRequest);
  }
}
