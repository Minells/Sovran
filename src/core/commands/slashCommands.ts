import { normalizeToolUnits } from '../tools/loading';

export interface SlashCommand {
  name: string;
  description: string;
  /** `prompt` expands into a message for the model; `action` is handled by the host. */
  kind: 'prompt' | 'action';
  template?: string;
  source: 'builtin' | 'workspace';
  /** Tool units the command needs, loaded with its first request when tools load on demand. */
  tools?: string[];
}

const DEFAULT_TARGET = 'the attached code';

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'explain',
    description: 'Explain the selection, a file or a concept',
    kind: 'prompt',
    source: 'builtin',
    template: 'Explain $ARGUMENTS. Cover what it does, how it works and anything surprising. Cite file paths and line numbers.',
  },
  {
    name: 'fix',
    description: 'Find and fix problems (uses editor diagnostics)',
    kind: 'prompt',
    source: 'builtin',
    template:
      'Fix the problems in $ARGUMENTS. Start by reading the diagnostics with get_active_editor_context, find the root cause, make the smallest correct change and verify it.',
    tools: ['diagnostics'],
  },
  {
    name: 'test',
    description: 'Write tests following the project conventions',
    kind: 'prompt',
    source: 'builtin',
    template:
      'Write focused unit tests for $ARGUMENTS. Find an existing test first and follow the framework and conventions already used in this repository. Run the tests if a test command is available.',
  },
  {
    name: 'review',
    description: 'Review code for bugs and risks without editing',
    kind: 'prompt',
    source: 'builtin',
    template:
      'Review $ARGUMENTS like a senior engineer. List concrete bugs, security issues and risky assumptions first, ordered by severity, with file:line references. Do not modify any file.',
    // Reviews are often of local changes.
    tools: ['git'],
  },
  {
    name: 'doc',
    description: 'Write documentation comments',
    kind: 'prompt',
    source: 'builtin',
    template: 'Write clear documentation comments for $ARGUMENTS, following the conventions of the language and of this repository.',
  },
  { name: 'compact', description: 'Summarize older messages to free context', kind: 'action', source: 'builtin' },
  { name: 'new', description: 'Start a new chat', kind: 'action', source: 'builtin' },
];

const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-zA-Z][\w-]{0,40})(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

export function expandCommand(command: SlashCommand, args: string): string {
  const template = command.template ?? '';
  if (template.includes('$ARGUMENTS')) return template.replace(/\$ARGUMENTS/g, args || DEFAULT_TARGET);
  return args ? `${template}\n\n${args}` : template;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** `key: value` lines of a front matter block; other lines are ignored. */
function frontMatter(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return fields;
}

/** `[git, web]`, `git, web` or `git web`, with or without quotes. */
function unitList(value: string | undefined): string[] {
  if (!value) return [];
  return normalizeToolUnits(
    value
      .replace(/^\[|\]$/g, '')
      .split(/[,\s]+/)
      .map((item) => item.replace(/^['"]|['"]$/g, '')),
  );
}

/**
 * A custom command is a Markdown file in `.sovran/commands/<name>.md`. Its first non-empty line is the
 * description; the whole file is the prompt template (use $ARGUMENTS where the user's text goes).
 *
 * An optional front matter block (`---` lines) may set `description` and `tools`, the units the command needs
 * (for example `tools: [git, web]`). The block is not part of the template.
 */
export function parseCustomCommand(fileName: string, content: string): SlashCommand | null {
  const name = fileName.replace(/\.md$/i, '').toLowerCase();
  const header = FRONT_MATTER.exec(content);
  const fields = header ? frontMatter(header[1]!) : new Map<string, string>();
  const body = header ? content.slice(header[0].length) : content;
  if (!NAME_RE.test(name) || !body.trim()) return null;
  const tools = unitList(fields.get('tools'));
  const first = body.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  let label = first.replace(/^#+\s*/, '');
  if (first.startsWith('<!--')) {
    const comment = first.slice('<!--'.length);
    // Extract only the comment text for the plain-text label. The template keeps the whole line.
    const closing = /--!?>/.exec(comment);
    label = comment.slice(0, closing?.index);
  }
  const description = (fields.get('description') || label).trim().slice(0, 80) || `Custom command /${name}`;
  return {
    name,
    description,
    kind: 'prompt',
    source: 'workspace',
    template: body.slice(0, 20_000),
    ...(tools.length ? { tools } : {}),
  };
}

/** Built-ins first; workspace commands may override built-in *prompt* commands but never actions. */
export function mergeCommands(custom: readonly SlashCommand[]): SlashCommand[] {
  const byName = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));
  for (const c of custom) {
    const existing = byName.get(c.name);
    if (existing?.kind === 'action') continue;
    byName.set(c.name, c);
  }
  return [...byName.values()];
}
