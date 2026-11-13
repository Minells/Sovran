/**
 * Requests as users type them, with the tool units each one needs. The router test measures precision and recall per
 * unit on this list. Add a line whenever the router misses or overreaches on a real request.
 *
 * Expected units include the ones loading adds anyway (Git reads for Git writes and remote operations).
 */
export const ROUTING_SERVERS = [
  { id: 'github', name: 'GitHub MCP', integration: 'github' },
  { id: 'gitlab', name: 'GitLab MCP', integration: 'gitlab' },
  { id: 'playwright', name: 'Playwright MCP', integration: 'playwright' },
  { id: 'devtools', name: 'Chrome DevTools MCP', integration: 'devtools' },
  { id: 'context7', name: 'Context7 MCP', integration: 'context7' },
  { id: 'jira', name: 'Jira Cloud' },
] as const;

export const ROUTING_CORPUS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Nothing beyond the core
  ['Spiegami cosa fa questo file', []],
  ['Explain how the agent loop works', []],
  ['Scrivi un test per la funzione parseSlash e lancialo', []],
  ['Add error handling to the fetch call in api.ts', []],
  ['Aggiungi la gestione degli errori nella funzione di login', []],
  ['Define a function that normalizes the paths', []],
  ['Ottimizza questo ciclo, è troppo lento', []],
  ['Use array.push instead of concat here', []],
  ['Crea un componente React per la pagina di login', []],
  ['Fix the bug where the counter resets', []],
  ['Write documentation comments for the exported functions', []],
  ['Implementa una pipeline di dati che legge il CSV e lo trasforma', []],
  ['Add a warning toast when the save fails', []],
  ['Rendi il layout responsive per mobile', []],
  ['Convert this class to a functional component', []],
  ['Aggiorna le dipendenze nel package.json', []],
  ["Che differenza c'è tra let e const?", []],
  ['This is difficult, can you simplify the reducer?', []],
  ['Leggi il README e dimmi come si installa', []],
  ['Generate a SQL migration for the users table', []],
  ['At this stage, just sketch the API without implementing it', []],
  ['Pull the user data from the API and display it', []],
  ['Le push notifications non arrivano su Android, perché?', []],
  ['Crea uno script che fa il deploy in staging', []],
  ["There's an issue with the parser, can you look?", []],
  ['Open the page component and add a loading state', []],
  ['Aggiungi un header alla tabella', []],
  ['Make the browser tab title show the unread count', []],

  // Git reads
  ['Mostrami le modifiche non committate', ['git']],
  ['What changed in the last commit?', ['git']],
  ['Fammi vedere il diff dei file modificati', ['git']],
  ['Su che branch sono?', ['git']],
  ['Show me the git log for src/core', ['git']],
  ['Chi ha modificato questa riga? Usa git blame', ['git']],
  ['Riassumi gli ultimi 5 commit', ['git']],
  ['Ho un conflitto di merge in config.ts, aiutami a risolverlo', ['git']],
  ['Review my uncommitted changes before I ship', ['git']],
  ['Compare this branch with main', ['git']],
  ['Cosa ho cambiato oggi?', ['git']],

  // Git writes
  ['Committa le modifiche con un messaggio sensato', ['git', 'git.changes']],
  ['Commit these changes with a good message', ['git', 'git.changes']],
  ['Scrivi un messaggio di commit per queste modifiche e fai il commit', ['git', 'git.changes']],
  ['Stage only the files in src/core and commit them', ['git', 'git.changes']],
  ['Fai unstage di config.yaml', ['git', 'git.changes']],
  ['Crea un commit separato per i test', ['git', 'git.changes']],

  // Git remote operations
  ['Fai push del branch', ['git', 'git.remote']],
  ['Push my changes to origin', ['git', 'git.remote']],
  ['Committa e pusha tutto', ['git', 'git.changes', 'git.remote']],
  ['Rebase this branch onto main', ['git', 'git.remote']],
  ['Fai il pull da origin e aggiorna il branch', ['git', 'git.remote']],
  ['git fetch and tell me if main moved', ['git', 'git.remote']],
  ['Sincronizza con il remoto', ['git', 'git.remote']],

  // Diagnostics
  ['Perché non compila?', ['diagnostics']],
  ['Fix the TypeScript errors in this file', ['diagnostics']],
  ['Ci sono warning di lint, sistemali', ['diagnostics']],
  ['The build fails with type errors', ['diagnostics']],
  ['Correggi gli errori nel file attivo', ['diagnostics']],
  ["What's wrong with this file? It's all red", ['diagnostics']],
  ['Run the typecheck and fix what it reports', ['diagnostics']],
  ["Risolvi i problemi segnalati dall'editor", ['diagnostics']],

  // Symbols
  ['Dove viene usata questa funzione?', ['symbols']],
  ['Where is buildRequest defined?', ['symbols']],
  ['Find all references to ToolRegistry', ['symbols']],
  ['Rinomina la funzione loadUnits in tutto il progetto', ['symbols']],
  ['Who calls executeCall?', ['symbols']],
  ['Refactor the controller into smaller services', ['symbols']],
  ["Fammi l'outline di agentRunner.ts", ['symbols']],
  ['Vai alla definizione di effectiveLimits e spiegala', ['symbols']],

  // Web
  ['Leggi https://code.visualstudio.com/api e riassumi le novità', ['web']],
  ['Summarize https://github.com/microsoft/playwright-mcp', ['web']],
  ['Check www.example.com and tell me what the API returns', ['web']],
  ['Usa la doc su https://docs.python.org/3/library/asyncio.html per spiegarmi gather', ['web']],

  // Browser
  ['Apri localhost:3000 e controlla che il form funzioni', ['mcp:playwright']],
  ['Take a screenshot of the login page', ['mcp:playwright']],
  ['Test the signup flow in the browser', ['mcp:playwright']],
  ['Write an e2e test with Playwright for the checkout', ['mcp:playwright']],
  ['Vai su http://127.0.0.1:8080/admin e clicca su Salva', ['mcp:playwright']],
  ['Ci sono errori in console quando apro la dashboard?', ['mcp:devtools']],
  ['Analyze the network requests the page makes', ['mcp:devtools']],
  ['Run a performance trace on the home page', ['mcp:devtools']],

  // Code hosting
  ['Leggi la PR #42 e riassumi i commenti', ['mcp:github']],
  ['List the open pull requests', ['mcp:github']],
  ['Crea una issue su GitHub per questo bug', ['mcp:github']],
  ['Controlla la pipeline CI della merge request', ['mcp:gitlab']],
  ['Open a merge request for this branch on GitLab', ['git', 'mcp:gitlab']],
  ['Why did the gitlab pipeline fail?', ['mcp:gitlab']],

  // Documentation and custom servers
  ['Check the latest docs for React 19 useActionState', ['mcp:context7']],
  ['Cerca nella documentazione ufficiale di Vitest come si fa il mocking dei moduli', ['mcp:context7']],
  ['Use context7 to look up zod v4 discriminated unions', ['mcp:context7']],
  ['Leggi il ticket Jira PROJ-123', ['mcp:jira']],
  ['Close the jira issue once the tests pass', ['mcp:jira']],

  // Several at once
  ['Fix the type errors, then commit', ['diagnostics', 'git', 'git.changes']],
  ['Rinomina la classe e poi fai il push', ['symbols', 'git', 'git.remote']],
  ['Dopo il refactor, apri localhost:5173 e fai uno screenshot', ['symbols', 'mcp:playwright']],
  ['Leggi https://example.com/changelog e aggiorna il CHANGELOG, poi committa', ['web', 'git', 'git.changes']],
];
