import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../server/mcp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {
  readGuidance,
  buildCampaignPrompt,
  guidanceResources,
  campaignPlatforms,
  campaignPromptBudget,
  guideSections,
} from '../src/guidance.js';

test('MCP clients discover, read and load curated campaign guides without provider calls', async () => {
  const store = new Store(':memory:'),
    server = createMcpServer(new MirrorService(new Registry(), store), {tenantId: 't', userId: 'u', role: 'reader'}),
    client = new Client({name: 'guide-test', version: '1'}),
    [c, s] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s);
    await client.connect(c);
    const list = await client.listResources();
    assert.equal(list.resources.length, 13);
    const overview = await client.readResource({uri: 'amcp://guides/reporting-overview'});
    assert.ok(overview.contents.some(c => 'text' in c && c.text.includes('Google Sheets')));
    for (const resource of list.resources) {
      const result = await client.readResource({uri: resource.uri}),
        content = result.contents[0]!;
      assert.ok('text' in content && content.text.length > 500);
    }
    assert.equal((await client.listPrompts()).prompts[0]!.name, 'amcp_build_campaign');
    const prompt = await client.getPrompt({
      name: 'amcp_build_campaign',
      arguments: {platform: 'microsoft', request: 'Build a paused search campaign'},
    });
    assert.ok(JSON.stringify(prompt).includes('DailyBudget'));
    assert.ok(JSON.stringify(prompt).includes('Build a paused search campaign'));
    const help = await client.callTool({name: 'amcp_tool_help', arguments: {}});
    assert.ok(JSON.stringify(help).includes('amcp://guides/index'));
    assert.throws(() => readGuidance('amcp://guides/../../.env'));
    assert.throws(() => readGuidance('file:///etc/passwd'));
    assert.throws(() => buildCampaignPrompt({platform: 'unsupported'}));
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

// DOC-03: every documentation page opens with its front matter (status, tier). The reporting guide is also an MCP
// resource, which AI clients read as before: the page without its front matter, from its title on. The Skills guides
// keep their own front matter, as written.
test('the reporting guide AI clients read is its documentation page without the front matter', () => {
  const page = fs.readFileSync('docs/REPORTING-OVERVIEW.md', 'utf8'),
    served = readGuidance('amcp://guides/reporting-overview').text;
  assert.match(page, /^---\nstatus: reference\ntier: operator\n---\n\n# /);
  assert.equal(served, page.slice(page.indexOf('\n---\n\n') + '\n---\n\n'.length));
  assert.match(served, /^# Reporting Overview\n/);
  assert.equal(
    readGuidance('amcp://guides/index').text,
    fs.readFileSync('Skills/amcp-campaign-builder/SKILL.md', 'utf8'),
  );
});

test('guide references are complete and distinguish unsupported execution from metadata', () => {
  for (const {uri} of guidanceResources) {
    const text = readGuidance(uri).text;
    for (const match of text.matchAll(/\]\((?:references\/)?([a-z-]+)\.md\)/g))
      assert.ok(
        guidanceResources.some(r => r.name === match[1]),
        match[1],
      );
  }
  const reddit = readGuidance('amcp://guides/reddit').text;
  assert.ok(reddit.includes('CREATE_SAVED_AUDIENCE'));
  assert.ok(reddit.includes('Reddit private Drive import, Reddit Max and customer-list ingestion remain unqualified'));
  assert.ok(reddit.includes('CREATE_STRUCTURED_POST_JOB'));
  assert.ok(reddit.includes('verified_resources[0].id'));
  assert.ok(reddit.includes('Never\nrepeat the POST'));
  assert.ok(reddit.includes('does not certify identical bytes/appearance'));
  assert.ok(readGuidance('amcp://guides/google-ads').text.includes('negative campaign keyword'));
});

test('every campaign prompt stays within its budget and keeps the campaign rules a brief needs (MCP-01, D14)', () => {
  for (const platform of campaignPlatforms) {
    const text = buildCampaignPrompt({platform, request: 'Build a paused search campaign'}).messages[0]!.content.text;
    assert.ok(text.length <= campaignPromptBudget, platform + ': ' + text.length);
    assert.ok(text.includes('Build a paused search campaign'), platform);
  }
  // The Microsoft guide no longer fits whole beside the skill and the workspace index (CMP-03's location lookup grew
  // it), so the prompt carries its section index and the sections the brief shares words with; the Search campaign
  // rules and the activation location gate are among them, and every section left out is named with the call that
  // reads it.
  const microsoft = buildCampaignPrompt({platform: 'microsoft', request: 'Build a paused search campaign'}).messages[0]!
    .content.text;
  const sections = guideSections('microsoft-ads');
  for (const id of ['search-campaigns', 'activation-and-locations-owner-decision-p7'])
    assert.ok(microsoft.includes(sections.find(s => s.id === id)!.text), id);
  assert.match(microsoft, /Campaign creation needs Name plus DailyBudget\/BudgetType or an existing BudgetId/);
  assert.match(microsoft, /LOCATION_CRITERIA_REQUIRED/);
  for (const section of sections)
    assert.ok(microsoft.includes(section.text) || microsoft.includes('- `' + section.id + '` '), section.id);
});
