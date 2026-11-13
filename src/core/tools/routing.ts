/**
 * Request routing for on-demand tool loading: the units a request will probably need, read from what the user asked
 * before the first model call, so that most requests need no `load_tools` step.
 *
 * The router reads only the user's message (with a slash command's own template) and the command's declared units:
 * never attachments, files or tool results, so content the user did not write cannot load tools. It is plain pattern
 * matching, in English and Italian, with no model call and no latency. Its errors are asymmetric: a unit it misses costs
 * one model step to load; a unit it loads wrongly costs its definitions for the rest of the chat. Rules are therefore
 * broad for small units (diagnostics, web) and narrow for large ones (Git remote operations, MCP servers).
 */
import type { IntegrationId } from '../mcp/catalog';
import { withImplied } from './loading';

/** What the router can know about a request beyond its text. */
export interface RoutingHints {
  /** Units the slash command declares (built-in, or `tools:` in a custom command's front matter). */
  commandUnits?: readonly string[];
  /** Configured MCP servers: their names, and the catalog integration a managed server comes from. */
  servers?: readonly McpServerHint[];
}

export interface McpServerHint {
  id: string;
  name: string;
  integration?: IntegrationId;
}

export interface RoutedUnit {
  unit: string;
  /** What asked for it, for the log: the matched words, the command or the unit it builds on. */
  reason: string;
}

const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';

/** Case-insensitive alternatives matched as whole words (Unicode-aware, so accented Italian words work). */
function words(...alternatives: string[]): RegExp {
  return new RegExp(`${B}(?:${alternatives.join('|')})${E}`, 'iu');
}

/** Hosts `web_fetch` refuses: a browser integration can open them, the Web tool cannot. */
const PRIVATE_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[\w.-]+\.(?:local|internal|lan|test))$/i;
const URL_PATTERN = /\bhttps?:\/\/(\[[^\]\s]+\]|[^\s/?#:]+)\S*/gi;
const BARE_HOST_PATTERN = /(?<![\w@/.-])(?:www\.[\w-]+(?:\.[\w-]+)+|localhost:\d{2,5})/gi;

const NATIVE_RULES: readonly { unit: string; pattern: RegExp }[] = [
  {
    unit: 'diagnostics',
    pattern: words(
      'diagnostic\\p{L}*',
      '(?:lint|compiler|build|typescript|tsc|eslint) warnings?',
      'warnings? (?:di |del |in |nel |from |of )?(?:lint|eslint|typescript|tsc|compil\\p{L}*|build)',
      'lint\\p{L}*',
      'eslint',
      'tsc',
      'type-?check\\p{L}*',
      '(?:compile|compiler|compilation|build|type|lint|syntax) errors?',
      'errori? (?:di )?(?:compilazione|build|tipo|tipi|lint|sintassi)',
      "(?:doesn'?t|does not|won'?t|will not|fails? to) (?:compile|build)",
      'non (?:compila|builda|passa (?:il )?(?:lint|typecheck))',
      'problems? (?:panel|tab|view)',
      'pannello (?:dei )?problemi',
      '(?:errors|problems) in (?:this|the|my) (?:file|project|workspace)',
      '(?:errori|problemi) (?:nel|del|in questo) (?:file|progetto|workspace)',
      "what'?s wrong with (?:this|the|my) (?:file|code)",
      'cosa non va (?:in|nel) (?:questo )?(?:file|codice)',
      '(?:fix|correct) (?:the |all |these |those )?(?:errors|problems|warnings)',
      '(?:correggi|risolvi|sistema) (?:gli |i |tutti gli |tutti i |questi )?(?:errori|problemi|warning)',
      'red (?:squiggl\\p{L}*|underlines?)',
      'sottolineat\\p{L}* (?:in )?ross\\p{L}*',
    ),
  },
  {
    unit: 'symbols',
    pattern: words(
      'where (?:is|are) [^.?!\\n]{1,60}(?:defined|declared|used|called|referenced|implemented)',
      'dove (?:è|e\'|viene|vengono|sono|si trova|si trovano) [^.?!\\n]{0,60}(?:definit\\p{L}*|dichiarat\\p{L}*|usat\\p{L}*|utilizzat\\p{L}*|chiamat\\p{L}*|richiamat\\p{L}*|implementat\\p{L}*)',
      'dove (?:viene|vengono) (?:usat|utilizzat|chiamat|richiamat|definit|dichiarat)\\p{L}*',
      'go to definition',
      'vai alla definizione',
      'definizione (?:di|del|della|dello)',
      'definition of',
      'references? (?:to|of)',
      '(?:all|find|show|list) (?:the )?references',
      '(?:i |tutti i )?riferimenti (?:a|al|alla|allo|ai|alle|di|del|della)',
      'usages?',
      '(?:tutti )?gli utilizzi',
      'occorrenze',
      'call ?sites?',
      'callers?',
      'who calls',
      'chi (?:la |lo |li |le )?(?:chiama|usa|richiama)',
      'find (?:all )?(?:uses|usages)',
      'rinomin\\p{L}*',
      'renam\\p{L}*',
      'refactor\\p{L}*',
      'outline',
      'symbols? (?:in|of)',
      'list (?:the )?symbols',
      'simboli (?:del|nel|di|in)',
      'struttura del file',
      'file structure',
    ),
  },
  {
    unit: 'git',
    pattern: words(
      'git',
      'diffs?',
      'commits?',
      'branch\\p{L}*',
      'ram[oi] (?:git|corrente|attuale|di (?:lavoro|sviluppo))',
      'blame',
      '(?:commit |git )?history',
      'cronologia',
      'storico (?:dei commit|git|del repo\\p{L}*)',
      'uncommitted',
      'non (?:ancora )?committat\\p{L}*',
      'merge conflicts?',
      'conflitt\\p{L}* (?:di )?merge',
      'what (?:did I|have I|has) changed?',
      'cosa (?:ho|abbiamo|è) (?:cambiato|modificato)',
      'local changes',
      'modifiche (?:locali|in sospeso|pendenti)',
      '(?:repo|repository) status',
      'stato del (?:repo|repository)',
    ),
  },
  {
    unit: 'git.changes',
    pattern: words(
      // Not committato/committate/committed: "modifiche non committate" asks to read, not to commit.
      'committ(?!at|ed)\\p{L}*',
      'commit (?:the|these|this|my|all|it|them|everything|changes|what)',
      '(?:then|and|finally|please|poi|e|quindi|infine) commit',
      '(?:make|create|write|do) (?:a |the )?commit',
      '(?:fai|crea|scrivi|fare|creare) (?:il |un |lo )?commit',
      'commit message',
      'messaggio di commit',
      'stage (?:the |these |this |all |my |i |le |il |questo |questi |tutti i |tutte le )?(?:files?|changes|modifiche)',
      'git stage',
      'unstage\\p{L}*',
      'staging area',
      'area di staging',
      'git add',
    ),
  },
  {
    unit: 'git.remote',
    pattern: words(
      'git (?:push|pull|fetch|rebase)',
      'push\\p{L}* (?:the |this |my |il |questo |questa |i |le |al |sul |su |to |on |a )?(?:branch|changes|commits?|modifiche|remote|remoto|origin|upstream|main|master)',
      'pusha\\p{L}*',
      '(?:fai|fare) (?:il |un )?(?:push|pull|fetch|rebase)',
      'pull (?:from|da|the latest|gli ultimi|le ultime)',
      'pulla\\p{L}*',
      'rebas\\p{L}*',
      'upstream',
      'origin/\\S+',
      '(?:sync|sincronizza\\p{L}*) (?:with|con) (?:the |il |lo )?(?:remote|remoto|origin|upstream)',
      'aggiorna\\p{L}* (?:il |questo )?branch',
    ),
  },
];

/** Words that ask for a catalog integration, beyond its name. Every integration needs an entry. */
const INTEGRATION_RULES: Readonly<Record<IntegrationId, RegExp>> = {
  github: words('github', 'pull requests?', 'PRs?', 'PR ?#?\\d+'),
  gitlab: words('gitlab', 'merge requests?', 'MRs?', 'CI/CD', '(?:CI|gitlab) pipelines?', 'pipelines? (?:CI|gitlab)'),
  playwright: words(
    'playwright',
    'in (?:the |a |al |nel |un )?browser',
    'browser automation',
    'screenshot\\p{L}*',
    'clicca\\p{L}*',
    'click (?:on|the|su|sul)',
    '(?:compila|riempi) (?:il )?form',
    'fill (?:in |out )?(?:the )?form',
    'e2e',
    'end[- ]to[- ]end',
  ),
  devtools: words(
    'devtools',
    '(?:browser )?console (?:errors?|logs?|messages?|output)',
    'errori (?:in|nella|della) console',
    'console del browser',
    'network (?:requests?|tab|calls?|panel)',
    'richieste di rete',
    'performance (?:trace|profile|insights?|audit)',
    'lighthouse',
    'core web vitals',
  ),
  context7: words(
    'context7',
    '(?:latest|current|up-to-date|official) (?:docs|documentation|api)',
    'documentazione (?:ufficiale|aggiornata)',
    '(?:look up|check|consult|read|search) (?:the )?(?:docs|documentation)',
    '(?:cerca|consulta|leggi|controlla) (?:nella |la )?documentazione',
    'docs (?:for|of) (?:the )?(?:library|package|framework)',
  ),
};

/** Words too generic to stand for a custom server by name. */
const GENERIC_NAME_WORDS = new Set(['server', 'servers', 'tool', 'tools', 'local', 'remote', 'http', 'stdio', 'with', 'client']);

function hosts(text: string): { public: string[]; private: string[] } {
  const out = { public: [] as string[], private: [] as string[] };
  for (const match of text.matchAll(URL_PATTERN)) {
    const host = match[1]!.toLowerCase();
    (PRIVATE_HOST.test(host) ? out.private : out.public).push(match[0]);
  }
  for (const match of text.matchAll(BARE_HOST_PATTERN)) {
    const value = match[0];
    (value.toLowerCase().startsWith('localhost') ? out.private : out.public).push(value);
  }
  return out;
}

function nameWords(server: McpServerHint): RegExp | undefined {
  const tokens = new Set(
    `${server.id} ${server.name}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 4 && !GENERIC_NAME_WORDS.has(token)),
  );
  return tokens.size ? words(...[...tokens].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : undefined;
}

/**
 * Units the request asks for, among `loadable`, each with its reason. Units it builds on come first, as loading adds
 * them.
 */
export function routeToolUnits(text: string, loadable: readonly string[], hints: RoutingHints = {}): RoutedUnit[] {
  const routed = new Map<string, string>();
  const ask = (unit: string, reason: string) => {
    if (loadable.includes(unit) && !routed.has(unit)) routed.set(unit, reason);
  };

  for (const unit of hints.commandUnits ?? []) ask(unit, 'command');

  const found = hosts(text);
  if (found.public.length) ask('web', `URL ${found.public[0]}`);
  // Words inside a URL (github.com, /docs/) say where a page is, not which tools the request needs.
  const prose = text.replace(URL_PATTERN, ' ').replace(BARE_HOST_PATTERN, ' ');

  for (const rule of NATIVE_RULES) {
    const match = rule.pattern.exec(prose);
    if (match) ask(rule.unit, `"${match[0]}"`);
  }

  for (const server of hints.servers ?? []) {
    const unit = `mcp:${server.id}`;
    if (!loadable.includes(unit)) continue;
    const byName = nameWords(server)?.exec(prose);
    if (byName) {
      ask(unit, `"${byName[0]}"`);
      continue;
    }
    if (server.integration === 'playwright' && found.private.length) {
      ask(unit, `local URL ${found.private[0]}`);
      continue;
    }
    const byTopic = server.integration && INTEGRATION_RULES[server.integration].exec(prose);
    if (byTopic) ask(unit, `"${byTopic[0]}"`);
  }

  const units = withImplied([...routed.keys()]).filter((unit) => loadable.includes(unit));
  return units.map((unit) => ({ unit, reason: routed.get(unit) ?? 'needed by another unit' }));
}
