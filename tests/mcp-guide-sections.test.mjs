// V2-MCP-06, decision 5: the guides in sections. Under the v2 contract profile (opt-in per AI client, D26) a guide is served in
// sections of at most 12,000 bytes: as resources by the template amcp://guides/{guide}/{section} (the 2026-07-28 revision's
// resources/templates/list) and as the help topics of amcp_workspace. A heading's section that is longer is served in parts
// that name each other. Under legacy, and for every other caller, nothing changed: no templates, a section URI is an unknown
// resource, the help topics return the sections whole, and the whole guides are served as they always were.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as guidance from '../dist/src/guidance.js';
import {setContractProfile} from '../dist/src/mcp-client-profile.js';
import {oauthStack} from './helpers/mcp-oauth-stack.mjs';

// The cap is a decision, not a value to derive: the tests state it, so a change of it is a change of the tests.
const cap = 12000;
const bytes = text => Buffer.byteLength(text, 'utf8');
const template = 'amcp://guides/{guide}/{section}';
const guideNames = guidance.guidanceResources.map(resource => resource.name);
const longest = 'connected-website-and-mcp-workflows-october-2026';

// What a part of a longer section says about itself, read independently of the code that writes it: a first line naming
// the part unless it is the first, and a last line naming the next unless it is the last.
const header = /^> Part (\d+) of (\d+) of "(.*)"\.\n\n/;
const footer = /\n\n> Part (\d+) of (\d+)\. Continue with the section `([a-z0-9-]+)` of this guide\.\n$/;
/** One part's own text: the lines that name its place taken away. */
const strip = text => text.replace(header, '').replace(footer, '');
/** The parts' own text, checking that each says what it should of its place. */
function unwrap(parts) {
  return parts.map((part, i) => {
    const opening = header.exec(part.text),
      closing = footer.exec(part.text),
      place = 'part ' + (i + 1) + ' of ' + parts.length;
    assert.equal(Boolean(opening), i > 0, place + ': a heading line unless it is the first');
    assert.equal(Boolean(closing), i < parts.length - 1, place + ': a next-part line unless it is the last');
    if (opening) {
      assert.deepEqual(opening.slice(1, 3), [String(i + 1), String(parts.length)], place);
      assert.equal(opening[3], parts[0].title.replace(/ \(part 1 of \d+\)$/, ''), place);
    }
    if (closing) assert.deepEqual(closing.slice(1, 4), [String(i + 1), String(parts.length), parts[i + 1].id], place);
    return strip(part.text);
  });
}
const section = (text, id = 'a-long-section', title = 'A long section') => ({id, title, text});
const words = count => Array(count).fill('word').join(' ');
/** `count` paragraphs of about `size` bytes each, separated by blank lines, as a section's prose is. */
const paragraphs = (count, size) =>
  Array.from({length: count}, (_, i) => 'Paragraph ' + (i + 1) + ' ' + words(Math.floor(size / 5))).join('\n\n') + '\n';
/** A table: a header, its rule and `rows` rows with no blank line between them. */
const table = rows =>
  [
    '| Action | What it does |',
    '|---|---|',
    ...Array.from({length: rows}, (_, i) => '| `action_' + i + '` | ' + words(40) + ' |'),
  ].join('\n') + '\n';

test('a section longer than the cap is cut between paragraphs into parts that name each other and rejoin to it exactly', () => {
  const short = section(paragraphs(3, 1500));
  assert.deepEqual(guidance.splitGuideSection(short), [short], 'a section under the cap is served as it is');
  const long = section('## A long section\n\n' + paragraphs(25, 1000)),
    parts = guidance.splitGuideSection(long);
  assert.ok(bytes(long.text) > 2 * cap, 'the document is longer than two caps');
  assert.ok(parts.length >= 3, String(parts.length));
  assert.deepEqual(
    parts.map(part => part.id),
    parts.map((_, i) => (i === 0 ? 'a-long-section' : 'a-long-section-part-' + (i + 1))),
    'the first part keeps the section’s own id, so whatever named the section still reads it',
  );
  assert.deepEqual(
    parts.map(part => part.title),
    parts.map((_, i) => 'A long section (part ' + (i + 1) + ' of ' + parts.length + ')'),
  );
  assert.deepEqual(
    parts.map(part => part.part),
    parts.map((_, i) => ({
      number: i + 1,
      of: parts.length,
      ...(i < parts.length - 1 ? {next: 'a-long-section-part-' + (i + 2)} : {}),
    })),
  );
  // Whole parts only: none over the cap, and none a sliver (the cut falls where the text divides evenly).
  for (const part of parts) {
    assert.ok(bytes(part.text) <= cap, part.id + ': ' + bytes(part.text));
    assert.ok(bytes(part.text) >= cap / 4, part.id + ' is an orphan: ' + bytes(part.text));
  }
  // Nothing lost, nothing added, in order: the parts' own text, joined by the newline that separated their lines, is the section.
  const own = unwrap(parts);
  assert.equal(own.join('\n'), long.text);
  // The cut is between paragraphs: every part but the last ends on a blank line, and none starts on one.
  for (const text of own.slice(0, -1)) assert.match(text, /\n$/, 'a part ends where a paragraph ends');
  for (const text of own) assert.doesNotMatch(text, /^\n/, 'a part starts at a paragraph');
});

test('a section just over the cap is two even parts, not a full one and a sliver, and the lines that name a part’s place fit the cap', () => {
  const over = section(paragraphs(13, 1000)),
    halves = guidance.splitGuideSection(over);
  assert.ok(bytes(over.text) > cap && bytes(over.text) < cap * 1.2, String(bytes(over.text)));
  assert.equal(halves.length, 2);
  const sizes = halves.map(part => bytes(part.text));
  assert.ok(Math.min(...sizes) > 0.4 * Math.max(...sizes), 'the parts divide the text evenly: ' + sizes);
  assert.equal(unwrap(halves).join('\n'), over.text);
  // Paragraphs of ten long lines each, about 11,970 bytes: nearly a whole part, and the lines that name its place must still fit
  // the cap, so a part is filled to less than the cap, never to it.
  const lines = Array(10).fill('x'.repeat(1196)).join('\n'),
    near = section([lines, lines].join('\n\n')),
    nearParts = guidance.splitGuideSection(near);
  assert.ok(nearParts.length >= 2);
  for (const part of nearParts) assert.ok(bytes(part.text) <= cap, part.id + ': ' + bytes(part.text));
  assert.equal(unwrap(nearParts).join('\n'), near.text);
});

test('a table is cut between rows and never inside one, a fenced block that fits is kept whole, and the cap counts bytes', () => {
  const big = section('### A table\n\n' + table(120)),
    parts = guidance.splitGuideSection(big);
  assert.ok(bytes(big.text) > cap);
  assert.ok(parts.length >= 2);
  const own = unwrap(parts);
  assert.equal(own.join('\n'), big.text);
  for (const [i, part] of parts.entries()) {
    assert.ok(bytes(part.text) <= cap, part.id);
    // Every line of a part is a whole row of the table, its header and rule, or the section's heading line.
    for (const line of own[i].split('\n').filter(Boolean))
      assert.match(line, /^(### A table|\| .+ \||\|---\|---\|)$/, part.id + ': ' + line.slice(0, 60));
  }
  // A fenced block with a blank line inside it, small enough to fit, is never divided: every part holds balanced fences.
  const fence = '```json\n{\n  "a": 1,\n\n  "b": 2\n}\n```\n';
  const fenced = section(paragraphs(10, 1200) + '\n' + fence + '\n' + paragraphs(10, 1200) + '\n' + fence),
    fencedParts = guidance.splitGuideSection(fenced);
  assert.ok(fencedParts.length >= 2);
  assert.equal(unwrap(fencedParts).join('\n'), fenced.text);
  for (const part of fencedParts)
    assert.equal(
      part.text.split('\n').filter(line => line.startsWith('```')).length % 2,
      0,
      part.id + ' splits a fence',
    );
  // The cap is bytes: four paragraphs of 2,500 Arabic letters are 10,000 characters but 20,000 bytes.
  const arabic = section(['م', 'ن', 'ه', 'ي'].map(letter => letter.repeat(2500)).join('\n\n'));
  assert.ok(arabic.text.length < cap && bytes(arabic.text) > cap, 'fewer characters than the cap, more bytes');
  const arabicParts = guidance.splitGuideSection(arabic);
  assert.ok(arabicParts.length >= 2);
  for (const part of arabicParts) assert.ok(bytes(part.text) <= cap, part.id + ': ' + bytes(part.text));
  assert.equal(unwrap(arabicParts).join('\n'), arabic.text);
  // A line longer than a part can hold is kept whole in a part of its own, never cut and never looped on; the test of the real
  // guides below is what fails when a guide holds one.
  const wide = section(paragraphs(3, 600) + '\n' + 'x'.repeat(cap + 500) + '\n\n' + paragraphs(3, 600)),
    wideParts = guidance.splitGuideSection(wide);
  assert.equal(unwrap(wideParts).join('\n'), wide.text);
  assert.ok(wideParts.some(part => bytes(part.text) > cap));
});

test('every section of every guide is served under 12,000 bytes, in parts where it was longer, and nothing of a guide is lost', () => {
  assert.equal(guidance.guideSectionMaxBytes, cap);
  let split = 0;
  for (const name of guideNames) {
    const sections = guidance.guideSections(name),
      served = guidance.guideParts(name),
      own = [];
    // The ids are what a client puts in the template's {section}: slugs, each once.
    assert.equal(new Set(served.map(s => s.id)).size, served.length, name + ' has a section id twice');
    for (const s of served) {
      assert.match(s.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, name + '/' + s.id);
      assert.ok(
        bytes(s.text) <= cap,
        name + '/' + s.id + ' is ' + bytes(s.text) + ' bytes: divide its paragraph or table',
      );
      // A part never opens or closes a code fence its section did not.
      assert.equal(s.text.split('\n').filter(line => /^(```|~~~)/.test(line)).length % 2, 0, name + '/' + s.id);
    }
    // Section by section: one that fits is served as it is; one that did not is its parts, which rejoin to it.
    let at = 0;
    for (const original of sections) {
      const first = served[at];
      assert.equal(first?.id, original.id, name);
      if (bytes(original.text) <= cap) {
        assert.deepEqual(first, original, name + '/' + original.id + ' fits and is served as it is');
        own.push(first.text);
        at += 1;
        continue;
      }
      split += 1;
      const parts = served.slice(at, at + first.part.of);
      assert.equal(parts.length, first.part.of, name + '/' + original.id);
      own.push(unwrap(parts).join('\n'));
      assert.equal(own.at(-1), original.text, name + '/' + original.id + ' loses or adds text');
      at += parts.length;
    }
    assert.equal(at, served.length, name);
    // The guide is what its sections add up to: the file itself and, for the workspace guide, the section made from code after it.
    const file = guidance.readGuidance('amcp://guides/' + name).text,
      all = own.join('\n');
    assert.ok(
      name === 'workspace' ? all.startsWith(file + '\n') : all === file,
      name + ': the sections do not add up to the guide',
    );
  }
  // The guides really hold sections over the cap (the largest is 25,056 bytes), so the split above is of real documents.
  assert.ok(split >= 8, 'sections over the cap in today’s guides: ' + split);
  const legacyLongest = Math.max(...guideNames.flatMap(name => guidance.guideSections(name).map(s => bytes(s.text))));
  assert.ok(legacyLongest > 25000, 'the heading sections themselves are as they were, the longest 25,056 bytes');
});

// ---- Over the real stack ------------------------------------------------------------------------------------------------

const eras = ['legacy', 'modern'];
const protocol = {modern: '2026-07-28', legacy: '2025-11-25'};

/** One raw JSON-RPC request in an era's own framing, so the code of an error is the one on the wire. */
async function wire(s, access, era, method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + access,
    'mcp-protocol-version': protocol[era],
  };
  let body = {jsonrpc: '2.0', id: 1, method, params};
  if (era === 'modern') {
    headers['mcp-method'] = method;
    if (method === 'resources/read') headers['mcp-name'] = params.uri;
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol.modern,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
  }
  const response = await fetch(s.url, {method: 'POST', headers, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}
/** Two AI clients of one workspace: one opted in to the v2 profile, and one that never was. */
async function twoClients(t) {
  const s = await oauthStack(t),
    v2 = await s.connect('Sections client'),
    plain = await s.connect('Plain client');
  assert.equal(setContractProfile(s.store, v2.client.client_id, 'v2'), true);
  return {s, v2, plain};
}
/** `amcp_workspace help` (or `amcp_tool_help`) for a guide topic, as a client calls it: the data of the answer. */
async function help(client, topic, tool = 'amcp_workspace') {
  const result = await client.callTool({
    name: tool,
    arguments: tool === 'amcp_workspace' ? {action: 'help', topic} : {topic},
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.success, true);
  return result.structuredContent.data;
}
/** The text of a resource read, which is one content. */
async function read(client, uri) {
  const {contents} = await client.readResource({uri});
  assert.equal(contents.length, 1, uri);
  assert.equal(contents[0].uri, uri);
  assert.equal(contents[0].mimeType, 'text/markdown');
  return contents[0].text;
}
const inChunks = async (items, work, size = 12) => {
  const done = [];
  for (let i = 0; i < items.length; i += size) done.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return done;
};

test('v2, 2026-07-28: the template is offered, every section reads under the cap, and the sections rejoin to each guide', async t => {
  const {s, v2} = await twoClients(t),
    client = await s.client('modern', v2.access);
  const {resourceTemplates} = await client.listResourceTemplates();
  assert.equal(resourceTemplates.length, 1);
  const [offered] = resourceTemplates;
  assert.equal(offered.uriTemplate, template);
  assert.equal(offered.mimeType, 'text/markdown');
  assert.match(offered.description, /12,000 bytes/, 'the template says how large a section is');
  assert.match(offered.description, /guides\/<guide>/, 'and where a guide’s section names are listed');
  // The listing of the guides is the thirteen, whole, as ever: the sections are reached by the template.
  assert.deepEqual(
    (await client.listResources()).resources.map(r => r.uri),
    guideNames.map(name => 'amcp://guides/' + name),
  );
  for (const name of guideNames) {
    const index = await help(client, 'guides/' + name),
      ids = index.sections.map(entry => entry.id);
    assert.deepEqual(
      ids,
      guidance.guideParts(name).map(entry => entry.id),
      name + ': the index names the sections served',
    );
    const texts = await inChunks(ids, id => read(client, 'amcp://guides/' + name + '/' + id));
    for (const [i, text] of texts.entries())
      assert.ok(bytes(text) <= cap, name + '/' + ids[i] + ' is ' + bytes(text) + ' bytes');
    // Read as a client reads them, and cleared of the lines that name a part's place, the sections are the guide.
    const file = await read(client, 'amcp://guides/' + name),
      all = texts.map(strip).join('\n');
    assert.ok(
      name === 'workspace' ? all.startsWith(file + '\n') : all === file,
      name + ': the sections are not the guide',
    );
  }
});

test('v2, an earlier revision: the sections read as well, and the template is not offered, as before', async t => {
  const {s, v2} = await twoClients(t),
    client = await s.client('legacy', v2.access),
    uri = 'amcp://guides/workspace/' + longest;
  // The profile is the client's, not the revision's: a section is read on either. The earlier revisions never listed templates.
  const first = await read(client, uri);
  assert.ok(bytes(first) <= cap);
  assert.match(first, /> Part 1 of \d+\. Continue with the section `[a-z0-9-]+-part-2` of this guide\.\n$/);
  await assert.rejects(client.listResourceTemplates(), error => {
    assert.equal(error.code, -32601);
    return true;
  });
});

for (const era of eras)
  test(`legacy profile, ${era}: no templates, no section resources, the help topics return a section whole, the guides are as they were`, async t => {
    const {s, plain} = await twoClients(t),
      client = await s.client(era, plain.access),
      key = s.store.createKey({tenantId: 'local', userId: 'script', role: 'operator'}),
      keyed = await s.client(era, key);
    for (const caller of [client, keyed]) {
      if (era === 'modern') assert.deepEqual((await caller.listResourceTemplates()).resourceTemplates, []);
      assert.equal((await caller.listResources()).resources.length, 13);
      // The whole guide is the file, as ever, and a section as a resource is unknown to a client that did not opt in.
      assert.equal(
        await read(caller, 'amcp://guides/workspace'),
        guidance.readGuidance('amcp://guides/workspace').text,
      );
      await assert.rejects(caller.readResource({uri: 'amcp://guides/workspace/' + longest}), error => {
        assert.equal(error.code, -32602, 'the SDK client normalizes the code; the wire code is tested below');
        return true;
      });
      // The help topics are what they were: the index lists the heading sections, and the long one is returned whole.
      for (const tool of ['amcp_workspace', 'amcp_tool_help']) {
        const index = await help(caller, 'guides/workspace', tool);
        assert.deepEqual(
          index.sections.map(entry => entry.id),
          guidance.guideSections('workspace').map(entry => entry.id),
        );
        assert.equal(index.max_section_bytes, undefined);
        assert.equal(index.section_uri_template, undefined);
        const whole = await help(caller, 'guides/workspace/' + longest, tool),
          original = guidance.guideSections('workspace').find(entry => entry.id === longest);
        assert.equal(whole.text, original.text);
        assert.ok(bytes(whole.text) > 25000);
        assert.equal(whole.section_uri, undefined);
        assert.equal(whole.part, undefined);
        assert.equal(whole.next_call, undefined);
        // A part of it is an unknown section.
        const missing = await caller.callTool({
          name: tool,
          arguments:
            tool === 'amcp_workspace'
              ? {action: 'help', topic: 'guides/workspace/' + longest + '-part-2'}
              : {topic: 'guides/workspace/' + longest + '-part-2'},
        });
        assert.equal(missing.structuredContent.error.code, 'GUIDE_NOT_FOUND');
      }
    }
  });

// What a client asking for a resource that is not there is told: -32602 on the 2026-07-28 revision, and the earlier revisions'
// published -32002 with the guides' index in its data. A section is not there for a client that has not opted in, and neither is
// anything that only looks like one, for a client that has.
const notThere = [
  'amcp://guides/none',
  'amcp://guides/none/introduction',
  'amcp://guides/workspace/none',
  'amcp://guides/meta/' + longest,
  // A section that fits has no second part, and the first part of a long one is the section's own id.
  'amcp://guides/media/' + guidance.guideSections('media')[0].id + '-part-2',
  'amcp://guides/workspace/' + longest + '-part-1',
  'amcp://guides/workspace/' + longest + '-part-99',
  'amcp://guides/workspace/' + longest + '-part-02',
  'amcp://guides/workspace/',
  'amcp://guides/workspace//' + longest,
  'amcp://guides/workspace/' + longest + '/',
  'amcp://guides/workspace/' + longest + '/extra',
  'amcp://guides/workspace/' + longest.toUpperCase(),
  'amcp://guides/WORKSPACE/' + longest,
  'amcp://guides/workspace/' + longest + '?part=2',
  'amcp://guides/workspace/' + longest + '#top',
  'amcp://guides/workspace/..%2f..%2f.env',
  'amcp://guides/workspace/../../.env',
  'amcp://guides/../../.env',
  'amcp://guides/__proto__/introduction',
  'amcp://guides/constructor/constructor',
  'amcp://guides/',
  'amcp://guides',
  'amcp://other/workspace/' + longest,
  'file:///etc/passwd',
];
const refusal = {modern: -32602, legacy: -32002};

test('an unknown resource is -32602 on the 2026-07-28 revision and -32002 on the earlier ones, whatever the profile', async t => {
  const {s, v2, plain} = await twoClients(t);
  for (const era of eras)
    for (const [who, access] of [
      ['v2', v2.access],
      ['legacy', plain.access],
    ])
      for (const uri of notThere) {
        const answer = await wire(s, access, era, 'resources/read', {uri});
        assert.equal(answer.body.result, undefined, who + ' ' + era + ' ' + uri);
        assert.equal(
          answer.body.error?.code,
          refusal[era],
          who + ' ' + era + ' ' + uri + ': ' + JSON.stringify(answer.body),
        );
        assert.equal(answer.body.error.data.uri, uri.slice(0, 300));
        assert.equal(answer.body.error.data.index, 'amcp://guides/index');
      }
  // A section that exists is a resource for the client that opted in, on both revisions, and for no other.
  const uri = 'amcp://guides/workspace/' + longest;
  for (const era of eras) {
    const served = await wire(s, v2.access, era, 'resources/read', {uri}),
      unknown = await wire(s, plain.access, era, 'resources/read', {uri});
    assert.equal(served.body.error, undefined, era);
    assert.equal(served.body.result.contents[0].uri, uri);
    assert.equal(unknown.body.error.code, refusal[era], era);
  }
  // The whole guides, by their own URI, answer both as they did.
  for (const era of eras)
    for (const access of [v2.access, plain.access]) {
      const answer = await wire(s, access, era, 'resources/read', {uri: 'amcp://guides/workspace'});
      assert.equal(answer.body.result.contents[0].text, guidance.readGuidance('amcp://guides/workspace').text);
    }
});

test('v2 help topics: the index lists the parts, a long section’s own id is its first part, and next_call reads the rest', async t => {
  const {s, v2, plain} = await twoClients(t),
    client = await s.client('modern', v2.access),
    legacy = await s.client('modern', plain.access);
  for (const tool of ['amcp_workspace', 'amcp_tool_help']) {
    const index = await help(client, 'guides/workspace', tool),
      ids = index.sections.map(entry => entry.id);
    assert.equal(index.max_section_bytes, cap);
    assert.equal(index.section_uri_template, 'amcp://guides/workspace/{section}');
    assert.ok(ids.includes(longest) && ids.includes(longest + '-part-2'), 'the long section is listed as its parts');
    const titles = Object.fromEntries(index.sections.map(entry => [entry.id, entry.title]));
    assert.match(titles[longest], / \(part 1 of \d+\)$/);
    assert.match(titles[longest + '-part-2'], / \(part 2 of \d+\)$/);
    // The first part answers under the section's own id, says what it is part of, and names the next.
    const first = await help(client, 'guides/workspace/' + longest, tool);
    assert.equal(first.part, 1);
    assert.ok(first.parts >= 3);
    assert.ok(bytes(first.text) <= cap);
    assert.equal(first.section_uri, 'amcp://guides/workspace/' + longest);
    assert.deepEqual(first.next_call, {
      tool: 'amcp_workspace',
      arguments: {action: 'help', topic: 'guides/workspace/' + longest + '-part-2'},
    });
    // Following next_call to the end reads the section whole: the same text the legacy topic returns in one answer.
    const texts = [first.text];
    let data = first;
    while (data.next_call) {
      const next = await client.callTool({name: data.next_call.tool, arguments: data.next_call.arguments});
      data = next.structuredContent.data;
      assert.equal(data.part, texts.length + 1);
      assert.ok(bytes(data.text) <= cap);
      texts.push(data.text);
    }
    assert.equal(texts.length, first.parts);
    assert.equal(data.next_call, undefined, 'the last part names no next');
    const wholeLegacy = await help(legacy, 'guides/workspace/' + longest, tool);
    assert.equal(texts.map(strip).join('\n'), wholeLegacy.text);
    // A section that fits has no part fields, only the resource that serves it.
    const small = await help(client, 'guides/media/' + guidance.guideSections('media')[0].id, tool);
    assert.equal(small.part, undefined);
    assert.equal(small.next_call, undefined);
    assert.equal(small.section_uri, 'amcp://guides/media/' + guidance.guideSections('media')[0].id);
    assert.ok(small.text.length > 100);
  }
  // The guides' own list and an unknown guide or section are as they were.
  assert.equal((await help(client, 'guides')).guides.length, 13);
  const unknown = await client.callTool({
    name: 'amcp_workspace',
    arguments: {action: 'help', topic: 'guides/workspace/' + longest + '-part-99'},
  });
  assert.equal(unknown.structuredContent.error.code, 'GUIDE_NOT_FOUND');
});

test('a client’s profile applies at its next request: the template and the sections come and go with it', async t => {
  const {s, v2} = await twoClients(t),
    client = await s.client('modern', v2.access),
    uri = 'amcp://guides/workspace/' + longest,
    // An SDK client keeps a list for the ttlMs the server hints (300 s), so these are raw requests: what the server answers now.
    templates = async access => (await wire(s, access, 'modern', 'resources/templates/list', {})).body.result,
    sectionRead = async access => (await wire(s, access, 'modern', 'resources/read', {uri})).body;
  const listed = await templates(v2.access);
  assert.equal(listed.resourceTemplates.length, 1);
  assert.equal(
    listed.cacheScope,
    'private',
    'what the answer holds depends on the caller, so no shared cache may keep it',
  );
  assert.equal((await sectionRead(v2.access)).error, undefined);
  assert.equal(setContractProfile(s.store, v2.client.client_id, 'legacy'), true);
  assert.deepEqual((await templates(v2.access)).resourceTemplates, []);
  assert.equal((await sectionRead(v2.access)).error.code, -32602);
  assert.ok(bytes((await help(client, 'guides/workspace/' + longest)).text) > 25000);
  assert.equal(setContractProfile(s.store, v2.client.client_id, 'v2'), true);
  assert.equal((await templates(v2.access)).resourceTemplates.length, 1);
  assert.equal((await sectionRead(v2.access)).error, undefined);
  assert.ok(bytes((await help(client, 'guides/workspace/' + longest)).text) <= cap);
  // Another credential of the same client, by its refresh token, is the same client: it is served the sections as well.
  const refreshed = await v2.refresh();
  assert.equal((await templates(refreshed)).resourceTemplates.length, 1);
  assert.equal((await sectionRead(refreshed)).error, undefined);
});

test('the help topic of the contract profile announces the sections, their size and where they are read', async t => {
  const {s, v2, plain} = await twoClients(t);
  for (const access of [v2.access, plain.access]) {
    const client = await s.client('modern', access),
      topic = await help(client, 'mcp_profile'),
      change = topic.v2_changes.find(entry => entry.id === 'guide_sections');
    assert.ok(change, 'the topic lists the change');
    assert.match(change.text, /12,000 bytes/);
    assert.match(change.text, /amcp:\/\/guides\/\{guide\}\/\{section\}/);
    assert.match(change.text, /resources\/templates\/list/);
    assert.match(change.text, /-part-2/);
    assert.match(change.text, /guides\/<guide>\/<section>/);
    assert.match(change.text, /unchanged/);
  }
});
