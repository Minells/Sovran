export interface SlashCommand {
  name: string;
  description: string;
  /** `prompt` expands into a message for the model; `action` is handled by the host. */
  kind: 'prompt' | 'action';
  template?: string;
  source: 'builtin' | 'workspace';
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

/**
 * A custom command is a Markdown file in `.sovran/commands/<name>.md`. Its first non-empty line is the
 * description; the whole file is the prompt template (use $ARGUMENTS where the user's text goes).
 */
export function parseCustomCommand(fileName: string, content: string): SlashCommand | null {
  const name = fileName.replace(/\.md$/i, '').toLowerCase();
  if (!NAME_RE.test(name) || !content.trim()) return null;
  const first = content.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const description = first.replace(/^#+\s*|^<!--\s*|\s*-->$/g, '').trim().slice(0, 80) || `Custom command /${name}`;
  return { name, description, kind: 'prompt', source: 'workspace', template: content.slice(0, 20_000) };
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
