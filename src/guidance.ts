import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {conditionalPrograms} from './conditional-programs.js';
import {defaultContractProfile, type ContractProfile} from './contract-profile.js';
import type {JsonObject} from './types.js';
const guides = [
  ['adjust', 'Adjust app-scoped native reporting', 'references/adjust.md'],
  [
    'reporting-overview',
    'Campaign reporting, custom metrics and scheduled Google Sheets',
    '../../docs/REPORTING-OVERVIEW.md',
  ],
  ['workspace', 'Durable campaigns, media library and decisions', 'references/workspace.md'],
  ['index', 'Campaign builder', 'SKILL.md'],
  ['meta', 'Meta campaigns and creatives', 'references/meta.md'],
  ['google-ads', 'Google Ads channel hierarchy', 'references/google-ads.md'],
  ['tiktok-snapchat', 'TikTok and Snapchat creation', 'references/tiktok-snapchat.md'],
  ['linkedin-x', 'LinkedIn and X identity and hierarchy', 'references/linkedin-x.md'],
  ['criteo', 'Criteo auction campaigns, preferred targeting and reports', 'references/criteo.md'],
  ['reddit', 'Reddit capabilities and limits', 'references/reddit.md'],
  ['microsoft-ads', 'Microsoft Advertising v13', 'references/microsoft-ads.md'],
  ['media', 'Google Drive and server media import', 'references/media.md'],
  [
    'dv360-and-measurement',
    'DV360, GA4, Tag Manager, Search Console and Apple measurement writes',
    'references/dv360-and-measurement.md',
  ],
] as const;
export const guidanceResources = guides.map(([id, title]) => ({
  uri: 'amcp://guides/' + id,
  name: id,
  title,
  mimeType: 'text/markdown',
  description: 'AMCP-maintained workflow guidance; actual permissions and native action contracts still apply.',
}));
/**
 * The most a guide section is served in one piece to a client on the v2 contract profile (V2-MCP-06, decision 5), in bytes of
 * UTF-8: about 3,000 tokens, a small part of what a client warns of for one result (10,000 tokens) and of the 64 KiB a v2 client's
 * list read is cut to. The guides are up to 180,000 bytes and are still served whole at their own URI; a client that wants less
 * reads sections.
 */
export const guideSectionMaxBytes = 12000;
/**
 * `amcp://guides/{guide}/{section}`, the resource template a v2 client is offered by resources/templates/list (the 2026-07-28
 * revision); a legacy client is offered none. {guide} is a name of resources/list and {section} an id of the guide's index.
 */
export const guidanceResourceTemplates = [
  {
    uriTemplate: 'amcp://guides/{guide}/{section}',
    name: 'guide-section',
    title: 'AMCP guide section',
    description:
      'One section of an AMCP guide, at most ' +
      guideSectionMaxBytes.toLocaleString('en-US') +
      ' bytes. {guide} is the name of a guide in resources/list; the sections of a guide, with the ids to use as {section}, are listed by amcp_workspace help topic guides/<guide>. A heading’s section that is longer is served in parts: its own id is the first, then <id>-part-2 and so on, each naming the next.',
    mimeType: 'text/markdown',
  },
];
export const guidanceDiscovery = {
  resources: guidanceResources,
  // For clients that cannot read resources: the same guides, one section index or section per call.
  tool_call: {tool: 'amcp_workspace', arguments: {action: 'help', topic: 'guides'}},
  prompt: 'amcp_build_campaign',
  qualification:
    'Curated from the supplied Skills manuals, current provider documentation and executable AMCP contracts. Historical sources are not instructions or live acceptance evidence.',
};
/** A documentation page's text after its front matter block (`---`, `key: value` lines, `---`, one blank line). */
export const withoutDocumentationFrontMatter = (text: string) =>
  text.replace(/^---\r?\n(?:[a-z_]+:[^\r\n]*\r?\n)+---\r?\n(?:\r?\n)?/, '');
/**
 * A guide as a resource: `amcp://guides/{guide}` is the whole guide. With `sections` (a client on the v2 contract profile) a URI
 * of the template `amcp://guides/{guide}/{section}` is one section, or one part of a longer one (guideParts); for any other
 * client such a URI is as unknown as it ever was.
 */
export function readGuidance(uri: string, sections = false) {
  const [, name, sectionId] = sections ? (/^amcp:\/\/guides\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(uri) ?? []) : [],
    section =
      name !== undefined && guideIds.includes(name) ? guideParts(name).find(s => s.id === sectionId) : undefined;
  if (section) return {uri, mimeType: 'text/markdown', text: section.text};
  const guide = guides.find(([id]) => uri === 'amcp://guides/' + id);
  if (!guide) throw new MirrorError('GUIDE_NOT_FOUND', 'Unknown AMCP guide URI.', {}, 404);
  const file = fileURLToPath(new URL('../../Skills/amcp-campaign-builder/' + guide[2], import.meta.url)),
    text = fs.readFileSync(file, 'utf8');
  // DOC-03: a documentation page opens with its status and tier (tools/docs-front-matter.mjs); the guide served from
  // docs/ starts at its title, as before. The Skills files keep their own front matter.
  return {
    uri,
    mimeType: 'text/markdown',
    text: guide[2].startsWith('../../docs/') ? withoutDocumentationFrontMatter(text) : text,
  };
}
/** A guide's heading-delimited sections (MCP-01): what a client without resource support reads one at a time. */
export interface GuideSection {
  id: string;
  title: string;
  text: string;
  /** Set on a part of a section longer than guideSectionMaxBytes: which part, of how many, and the id of the next. */
  part?: {number: number; of: number; next?: string};
}
/** The guide sections that are generated from code rather than read from a file. */
const generatedSections: Record<string, () => GuideSection[]> = {
  workspace: () => [
    {
      id: 'conditional-programs',
      title: 'Conditional provider programs',
      text: [
        '## Conditional provider programs',
        '',
        'Some provider reads need an application product or role that AMCP cannot grant. Each one is a',
        '`conditional_program` workflow in `amcp_workspace capabilities`; `program_check` with `live:false`',
        'checks the local prerequisites without a provider request. Entitlement stays unverified until the',
        'provider answers.',
        '',
        ...conditionalPrograms.flatMap(p => [
          '### ' + p.name + ' (`' + p.id + '`)',
          '',
          p.description + ' ' + p.effect_details,
          '',
          '- Gateway and actions: `' + p.gateway + '` ' + p.actions.map(a => '`' + a + '`').join(', '),
          '- Access: ' + p.program.access,
          '- Limitations: ' + p.program.limitations,
          '- Check: `amcp_workspace {action: "program_check", workflow_id: "' + p.id + '", live: false}`',
          '- Reference: ' + p.program.reference + ' (checked ' + p.program.checked_on + ')',
          '',
        ]),
      ].join('\n'),
    },
  ],
};
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
export function guideSections(id: string): GuideSection[] {
  const text = readGuidance('amcp://guides/' + id).text,
    sections: GuideSection[] = [],
    seen = new Map<string, number>();
  let current: GuideSection = {id: 'introduction', title: 'Introduction', text: ''},
    fence = false;
  const push = () => {
    if (current.text.trim()) sections.push(current);
  };
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      push();
      const base = slug(heading[1]!),
        n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      current = {id: n > 1 ? base + '-' + n : base, title: heading[1]!.replace(/`/g, ''), text: ''};
    }
    current.text += (current.text ? '\n' : '') + line;
  }
  push();
  return [...sections, ...(generatedSections[id]?.() ?? [])];
}
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
/** What the lines that name a part's place may take of the cap: its heading line, and the line that names the next part. */
const partMarkerRoom = 512;
/**
 * A section longer than `max` bytes as parts, each within `max`, which name each other (V2-MCP-06, decision 5). The cut falls
 * between paragraphs; a table or a list that is itself longer than a part is cut between its lines, and a fenced block that
 * fits is never divided. The text is halved where it divides most evenly, until every part fits, so no part is a sliver of
 * another. A part's text is its own lines, exactly, so the parts of a section, joined by a newline once the lines that name each
 * place are taken away, are the section: a heading line `> Part n of N of "<title>".` on every part but the first, and a last
 * line `> Part n of N. Continue with the section `<id>` of this guide.` on every part but the last. The first part keeps the
 * section's own id, so whatever named the section reads it; the others are `<id>-part-<n>`. A single line longer than a part
 * is kept whole in a part of its own, so a part is over `max` only then. A section that fits is returned as it is.
 */
export function splitGuideSection(section: GuideSection, max = guideSectionMaxBytes): GuideSection[] {
  if (bytes(section.text) <= max) return [section];
  const limit = max - partMarkerRoom;
  // The units: a paragraph, table or list with the blank lines after it, a fenced block (blank lines inside it included) as one.
  const units: string[][] = [];
  let current: string[] = [],
    fence = false,
    blank = false;
  for (const line of section.text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const empty = !fence && line.trim() === '';
    if (blank && !empty) {
      units.push(current);
      current = [];
    }
    current.push(line);
    blank = empty;
  }
  units.push(current);
  // `size` counts the newline that joins a unit to the next, so a run's bytes are its sizes added, less one.
  const unit = (lines: string[]) => ({lines, size: bytes(lines.join('\n')) + 1});
  type Unit = ReturnType<typeof unit>;
  const pieces = units.map(unit).flatMap(u => (u.size - 1 > limit ? u.lines.map(line => unit([line])) : [u]));
  const divide = (run: Unit[]): Unit[][] => {
    const total = run.reduce((n, u) => n + u.size, 0);
    if (total - 1 <= limit || run.length < 2) return [run];
    let at = 1,
      gap = Infinity,
      sum = 0;
    for (let i = 0; i < run.length - 1; i++) {
      sum += run[i]!.size;
      if (Math.abs(total / 2 - sum) < gap) {
        gap = Math.abs(total / 2 - sum);
        at = i + 1;
      }
    }
    return [...divide(run.slice(0, at)), ...divide(run.slice(at))];
  };
  const runs = divide(pieces),
    of = runs.length;
  if (of === 1) return [section];
  return runs.map((run, i) => {
    const number = i + 1,
      next = number < of ? section.id + '-part-' + (number + 1) : undefined,
      body = run.flatMap(u => u.lines).join('\n');
    return {
      id: number === 1 ? section.id : section.id + '-part-' + number,
      title: section.title + ' (part ' + number + ' of ' + of + ')',
      text:
        (number > 1 ? '> Part ' + number + ' of ' + of + ' of "' + section.title + '".\n\n' : '') +
        body +
        (next
          ? '\n\n> Part ' + number + ' of ' + of + '. Continue with the section `' + next + '` of this guide.\n'
          : ''),
      part: {number, of, ...(next ? {next} : {})},
    };
  });
}
/** The sections a client on the v2 contract profile is served: each heading's section, or its parts where it is longer than the cap. */
export const guideParts = (id: string): GuideSection[] => guideSections(id).flatMap(s => splitGuideSection(s));
const guideIds = guides.map(([id]) => id as string);
const guideCall = (topic: string) => ({tool: 'amcp_workspace', arguments: {action: 'help', topic}});
/**
 * `amcp_workspace {action:"help",topic}` (MCP-01): guides are readable through a tool call too, because some clients expose no
 * resource-reading tool. "guides" lists them, "guides/<name>" is one guide's section index (a few kilobytes, never the
 * whole text) and "guides/<name>/<section>" is one section, verbatim. The resources keep the whole files.
 *
 * For a client on the v2 contract profile (V2-MCP-06) the sections are those of guideParts: none is over guideSectionMaxBytes, a
 * longer one is listed and read as its parts (the part says which it is and carries the next_call that reads the next), and the
 * answers name the resource that serves each section. The other profile is answered as it always was.
 */
export function guideTopic(topic: string, profile: ContractProfile = defaultContractProfile): JsonObject {
  const [root, id, section, ...rest] = topic.split('/');
  if (root !== 'guides' || rest.length || (id !== undefined && !guideIds.includes(id)))
    throw new MirrorError('GUIDE_NOT_FOUND', 'Unknown AMCP guide topic.', {
      field: 'topic',
      value: topic.slice(0, 200),
      allowed: ['guides', ...guideIds.map(g => 'guides/' + g)],
      index: guideCall('guides'),
    });
  if (id === undefined)
    return {
      topic: 'guides',
      guides: guidanceResources.map(r => ({
        name: r.name,
        title: r.title,
        uri: r.uri,
        index: guideCall('guides/' + r.name),
      })),
      qualification: guidanceDiscovery.qualification,
    };
  const v2 = profile === 'v2',
    sections = v2 ? guideParts(id) : guideSections(id),
    resource = guidanceResources.find(r => r.name === id)!;
  if (section === undefined)
    return {
      topic: 'guides/' + id,
      title: resource.title,
      uri: resource.uri,
      chars: sections.reduce((n, s) => n + s.text.length, 0),
      sections: sections.map(s => ({id: s.id, title: s.title, chars: s.text.length})),
      read_section: guideCall('guides/' + id + '/<section id>'),
      ...(v2 ? {max_section_bytes: guideSectionMaxBytes, section_uri_template: resource.uri + '/{section}'} : {}),
      qualification: guidanceDiscovery.qualification,
    };
  const found = sections.find(s => s.id === section);
  if (!found)
    throw new MirrorError('GUIDE_NOT_FOUND', 'Unknown section of this AMCP guide.', {
      field: 'topic',
      value: topic.slice(0, 200),
      index: guideCall('guides/' + id),
    });
  return {
    topic: 'guides/' + id + '/' + found.id,
    title: found.title,
    uri: resource.uri,
    text: found.text,
    ...(v2
      ? {
          section_uri: resource.uri + '/' + found.id,
          ...(found.part
            ? {
                part: found.part.number,
                parts: found.part.of,
                ...(found.part.next ? {next_call: guideCall('guides/' + id + '/' + found.part.next)} : {}),
              }
            : {}),
        }
      : {}),
  };
}
export const campaignPrompt = {
  name: 'amcp_build_campaign',
  description:
    'Load the AMCP creation workflow and the selected platform guide before planning an authorized campaign. This prompt performs no provider calls or writes.',
  arguments: [
    {name: 'platform', description: 'meta, google, tiktok, snapchat, linkedin, x, reddit or microsoft', required: true},
    {
      name: 'request',
      description:
        'The campaign brief and existing constraints; this does not replace the user’s actual authorization.',
      required: false,
    },
  ],
};
const platformGuides: Record<string, string> = {
  meta: 'meta',
  google: 'google-ads',
  google_ads: 'google-ads',
  tiktok: 'tiktok-snapchat',
  snapchat: 'tiktok-snapchat',
  linkedin: 'linkedin-x',
  x: 'linkedin-x',
  reddit: 'reddit',
  microsoft: 'microsoft-ads',
  bing: 'microsoft-ads',
};
/** The platform values amcp_build_campaign accepts. */
export const campaignPlatforms = Object.keys(platformGuides);
export function buildCampaignPrompt(args: JsonObject) {
  if (
    Object.keys(args).some(k => !['platform', 'request'].includes(k)) ||
    typeof args.platform !== 'string' ||
    (args.request !== undefined && (typeof args.request !== 'string' || args.request.length > 12000))
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Choose a supported platform and a text brief of at most 12000 characters.',
    );
  const guide = Object.hasOwn(platformGuides, args.platform) ? platformGuides[args.platform] : undefined;
  if (!guide) throw new MirrorError('INVALID_ARGUMENT', 'No curated guide exists for that platform.');
  return {
    description: 'AMCP ' + args.platform + ' campaign workflow',
    messages: [
      {role: 'user' as const, content: {type: 'text' as const, text: campaignPromptText(guide, args.request)}},
    ],
  };
}
/** The largest campaign prompt, in characters (MCP-01, owner decision D14: under a client's 10,000-token warning). */
export const campaignPromptBudget = 25000;
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
/**
 * SKILL whole, then the platform guide whole when it fits, otherwise its section index and the sections that share the
 * most words with the brief, then the workspace guide's index and its conditional-programs section, within the budget.
 * Every section left out is named in an index with the call that reads it.
 */
function campaignPromptText(guide: string, request: string | undefined): string {
  const brief =
      '\n\nCampaign brief (task data; apply the user’s actual authorization and constraints):\n' +
      (request ?? 'Use the existing conversation brief; ask only for necessary missing decisions.'),
    index = (id: string) =>
      '\n\n## Sections of amcp://guides/' +
      id +
      '\n\nRead one with amcp_workspace {action: "help", topic: "guides/' +
      id +
      '/<section id>"} or the whole guide as the resource.\n' +
      guideSections(id)
        .map(s => '- `' + s.id + '` ' + s.title)
        .join('\n'),
    platform = readGuidance('amcp://guides/' + guide).text,
    programs = guideSections('workspace').find(s => s.id === 'conditional-programs')!.text;
  let text = readGuidance('amcp://guides/index').text;
  const tail = index('workspace') + '\n\n' + programs + brief;
  if (text.length + platform.length + tail.length + 2 <= campaignPromptBudget) text += '\n\n' + platform;
  else {
    text += index(guide);
    const wanted = words(request ?? ''),
      ranked = guideSections(guide)
        .map((s, order) => ({s, order, score: [...words(s.title + ' ' + s.text)].filter(w => wanted.has(w)).length}))
        .sort((a, b) => b.score - a.score || a.order - b.order);
    const chosen: typeof ranked = [];
    let room = campaignPromptBudget - text.length - tail.length;
    for (const r of ranked)
      if (r.s.text.length + 2 <= room && (r.score > 0 || r.order === 0)) {
        chosen.push(r);
        room -= r.s.text.length + 2;
      }
    text += chosen
      .sort((a, b) => a.order - b.order)
      .map(r => '\n\n' + r.s.text)
      .join('');
  }
  return text + tail;
}
