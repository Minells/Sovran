# Caricamento dei tool su richiesta

Piano di implementazione basato su `main` al commit `e272af7`. Le etichette dell'interfaccia restano in inglese, come
nel resto dell'estensione.

## Obiettivo

Sovran deve mandare al modello solo i tool che servono alla richiesta in corso. Gli altri si aggiungono quando
servono. Sono tre i modi in cui un tool entra in una richiesta, e l'utente non deve fare nulla:

1. **Previsione dalla richiesta.** Prima della prima chiamata al modello, Sovran deduce dal messaggio i gruppi
   probabilmente necessari: "committa", un URL, "perché non compila".
2. **Richiesta del modello.** Il modello vede un indice compatto dei gruppi non caricati e li carica con
   `load_tools`.
3. **Chiamata diretta.** Se il modello chiama un tool non ancora caricato, Sovran carica il suo gruppo invece di
   rispondere "Unknown tool".

L'utente continua a usare l'agente come oggi. Nel transcript il caricamento è al massimo una riga discreta dentro
la riga *Explored*, e l'indicatore del contesto mostra cosa occupa la finestra.

## Principi

- **Le permission non cambiano.** Caricare un tool lo rende *visibile* al modello; non lo autorizza. Approvazioni,
  guardrail, MCP Off / Ask / Allow, gruppi esclusi per chat, tool disabilitati, Plan mode e Restricted Mode
  funzionano come oggi. Un tool non disponibile per questi motivi non compare nell'indice e non si può caricare.
- **Resta l'invariante "offered".** Un tool si esegue solo se era offerto nella richiesta che l'ha prodotto
  (`agentRunner.ts:501`). Il caricamento vale dalla richiesta successiva, e Sovran non esegue mai una chiamata a un
  tool non offerto.
- **Il prefisso del prompt resta stabile per la KV cache.** Ollama/llama.cpp, LM Studio, vLLM e SGLang riusano il
  prefisso comune tra richieste, e i chat template mettono i tool in testa. Ne seguono quattro regole:
  - il caricamento solo **aggiunge** e accoda i nuovi tool in fondo all'array;
  - l'indice e il system prompt non cambiano quando un gruppo viene caricato;
  - si scarica **solo negli eventi che invalidano comunque la cache**: compattazione e cambio di modello;
  - senza nuovi caricamenti, system prompt e array `tools` restano identici byte per byte tra un passo e l'altro.
- **Il comportamento di oggi resta disponibile.** `sovran.tools.loading: "all"` produce richieste identiche a quelle
  attuali.
- **Tutto il meccanismo sta nel core.** Unità, selezione, routing e `load_tools` vivono in `src/core` senza
  dipendenze da `vscode` (ADR-001), e si testano come il resto dell'agent loop.

## Misure di partenza

Stima a 3,5 caratteri per token, la stessa di `contextManager.ts:12`, sulle definizioni serializzate
(`ToolRegistry.schema`) in un workspace trusted.

| | Oggi | Con caricamento su richiesta | Differenza |
|---|---|---|---|
| Act, nessun MCP | 27 tool, ~4.850 token | nucleo ~1.315 + `load_tools` ~175 = **~1.490** | −69% |
| Plan, nessun MCP | 16 tool, ~2.970 token | nucleo ~708 + `load_tools` ~138 = **~846** | −72% |
| Ogni server MCP | tutte le definizioni, sempre | una riga d'indice finché non serve | — |

Costo delle unità caricabili (Act): `git` ~1.234, `git.remote` ~694, `symbols` ~583, `git.changes` ~569,
`diagnostics` ~281, `web` ~170.

Altre due leve, misurate e da usare insieme a questa:

- **Schemi più snelli.** Togliere dagli schemi inviati i vincoli che servono solo alla validazione zod (`minLength`,
  `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`) fa risparmiare l'11%, il 13% togliendo anche
  `additionalProperties`. La validazione resta lato Sovran.
- **Limite dei risultati.** `sovran.context.maxToolResultChars` vale 20.000 caratteri, circa 5.700 token per singolo
  risultato. Su una finestra da 32k un solo `read_file` grande ne occupa più di un sesto.

## Design

### Unità di caricamento

Un'*unità* è l'insieme minimo di tool che si carica in un colpo. Coincide con il gruppo, salvo dove il gruppo è
troppo grande o mescola tool sempre utili con tool occasionali.

| Unità | Tool | Caricamento |
|---|---|---|
| `core` | `read_file`, `list_directory`, `find_files`, `search_files`, `get_workspace_info`, `get_active_editor_context`, `write_file`, `edit_file`, `apply_diff`, `execute_terminal` | sempre |
| `diagnostics` | `get_diagnostics` | su richiesta |
| `symbols` | `list_document_symbols`, `go_to_definition`, `find_references` | su richiesta |
| `git` | `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches` | su richiesta |
| `git.changes` | `git_stage`, `git_unstage`, `git_commit` | su richiesta, porta con sé `git` |
| `git.remote` | `git_fetch`, `git_pull`, `git_push`, `git_rebase` | su richiesta, porta con sé `git` |
| `web` | `web_fetch` | su richiesta |
| `mcp:<server>` | tutti i tool attivi di quel server | su richiesta |

- Si aggiunge un campo opzionale `unit?: string` a `ToolDefinition`, impostato esplicitamente su ogni tool nativo.
  Un test fallisce se un tool nativo non ha un'unità valida: chi aggiunge un tool deve decidere.
- Per i tool MCP l'unità è il gruppo `mcp:<serverId>`.
- Le unità sono distinte dai gruppi di `excludedToolGroups`, che restano l'interfaccia utente per le esclusioni e non
  cambiano formato.

### Livelli di selezione

All'inizio di ogni run (`AgentRunner.run`) e prima del primo `buildRequest`:

1. **Soglia di budget.** Sia `B` il 10% del budget di input (finestra effettiva meno riserva di output, da
   `effectiveLimits`):
   - se tutte le unità disponibili stanno in `B`, si caricano tutte e la richiesta è identica a oggi;
   - altrimenti, se nucleo e unità native stanno in `B`, si caricano tutte le native e gli MCP restano su richiesta;
   - altrimenti si carica solo il nucleo.

   Esempi con riserva da 4k: con 32k di finestra `B` ≈ 2,9k, quindi solo il nucleo; con 128k `B` ≈ 12,4k, quindi
   tutte le native, più gli MCP se ci stanno.
2. **Stato della chat.** Le unità già caricate (`session.toolUnits`) restano caricate.
3. **Router.** Una funzione pura, `routeToolUnits`, legge il testo scritto dall'utente nell'ultimo messaggio
   (`display ?? content`) e l'eventuale comando slash, poi aggiunge le unità previste (sezione [Router](#router)).
4. **Il modello.** Durante il run il modello può chiamare `load_tools` o chiamare direttamente un tool non caricato.

Il risultato è un insieme ordinato. L'array `tools` di ogni richiesta è: nucleo in ordine di registro, poi
`load_tools`, poi le unità nell'ordine in cui sono state caricate.

### `load_tools`

È un tool virtuale costruito dal runner a ogni richiesta, non registrato nel `ToolRegistry`, perché agisce sullo
stato di caricamento della chat e non sul workspace.

```ts
// src/core/tools/loading.ts
export const LOAD_TOOLS = 'load_tools';

export interface LoadableUnit {
  id: string;            // 'git', 'git.changes', 'mcp:github'…
  label: string;         // 'Git', 'GitHub MCP'…: etichette di Sovran, mai testo del server
  tools: string[];       // nomi dei tool disponibili in questa modalità
  tokens: number;        // costo stimato delle definizioni
}

export function loadToolsSchema(units: readonly LoadableUnit[]): ToolSchema;
```

- **Descrizione:** `Load more tools before you use them. They are available from your next step.`, seguita da una
  riga per unità, per esempio `git.changes — git_stage, git_unstage, git_commit`.
- **Parametri:** `{ units: string[] }` con `enum` degli id. L'enum aiuta i server che vincolano la decodifica delle
  chiamate ai tool, e la validazione zod respinge gli id inventati.
- **Stabilità:** l'indice elenca tutte le unità caricabili della chat, anche quelle già caricate, in ordine
  deterministico. Cambia solo se cambia l'insieme di unità disponibili: un server MCP che si connette o si disconnette,
  un cambio Plan/Act, un'esclusione per chat.
- **Esecuzione:** è un tool di sola lettura, non chiede approvazione ed è disponibile anche in Plan. Il risultato
  conferma cosa è stato caricato (`Loaded git.changes: git_stage, git_unstage, git_commit.`). Caricare un'unità già
  caricata non fa nulla, e un'unità senza tool disponibili in questa modalità lo dice.
- **Assenza:** se non resta nulla da caricare (modalità `all`, soglia di budget superata, tutto già caricato
  all'inizio del run), `load_tools` non viene offerto e il system prompt non ha la riga relativa.
- **Nome riservato:** `ToolRegistry.register` rifiuta un tool nativo chiamato `load_tools`. I nomi MCP non possono
  collidere, perché iniziano con `mcp__`.

Il system prompt riceve una sola riga statica, assente quando `load_tools` non c'è:
`Some tools are loaded on demand: call load_tools with the units you need before using them.`

### Chiamata diretta a un tool non caricato

In `executeCall`, dopo i controlli esistenti su tool sconosciuto e Plan mode, al posto del rifiuto "not offered":

- se il tool esiste, la sua unità è caricabile e non caricata, e `registry.unavailable(tool, …)` non dà motivi,
  l'unità viene caricata;
- la chiamata **non** viene eseguita;
- il risultato ha stato `success`, un campo `loaded: ['git']` e testo
  `git_status was not loaded yet. Sovran loaded the Git tools: call git_status again with the same arguments.`

Ho scartato l'alternativa di scartare il passo e rigenerarlo con i tool presenti. Avrebbe un transcript più pulito,
ma butta il testo e il ragionamento già mostrati (sfarfallio nella UI) e, con un modello che ragiona a lungo come GLM,
spreca secondi di generazione.

Due ritocchi collegati:

- Il messaggio "Unknown tool" per un nome inventato aggiunge le unità caricabili: `Other tools can be loaded with
  load_tools: git, web…`.
- Il loop guard resta invariato: un caricamento ha esito `success` e non conta come fallimento. Ogni caricamento
  diretto aggiunge un'unità nuova, quindi i caricamenti per run sono al massimo quante sono le unità.

Questo percorso dipende dal fatto che il server restituisca una chiamata a un nome non presente in `tools`. Se il
parser del server la scarta e la lascia come testo `<tool_call>`, la gestisce già il `TaggedStreamParser` in modalità
nativa. Va comunque verificato su Ollama, LM Studio e GLM dietro APISIX (sezione
[Verifica manuale](#verifica-manuale-sui-due-setup)).

### Router

Il router è una funzione pura, `routeToolUnits(input): { unit: string; reason: string }[]`, in
`src/core/tools/routing.ts`. Non fa chiamate di rete o al modello e aggiunge zero latenza.

**Ingressi:**
- testo digitato dall'utente;
- nome del comando slash;
- template del comando: i comandi custom esistono solo nei workspace trusted;
- unità caricabili, con le etichette e le parole chiave del catalogo MCP.

Il contenuto di file, allegati e risultati dei tool **non** entra nel router: un file non può far caricare tool.

**Regole:** tabelle di pattern per unità, in inglese e italiano, case-insensitive, con confini di parola Unicode.

| Unità | Segnali forti (esempi) | Note |
|---|---|---|
| `git` | `git`, diff, branch/ramo, cronologia/history, blame, "ultimo commit", "modifiche non committate", uncommitted | `log` da solo no: "aggiungi un log" è un falso positivo |
| `git.changes` | commit/committa, stage, "messaggio di commit" | aggiunge anche `git` |
| `git.remote` | push, pull, fetch, rebase, upstream, remote/remoto, origin | aggiunge anche `git` |
| `diagnostics` | errore/errori/error, warning, problemi/problems, lint, "non compila", "doesn't compile", "type error", typecheck | unità economica: regole larghe |
| `symbols` | definizione/definition, riferimenti/references, "dove viene usat…", "where is … used/defined", "chi chiama", callers, rinomina/rename, refactor, outline | |
| `web` | un URL pubblico `https?://…` nel testo | senza URL `web_fetch` serve a poco: niente parole chiave generiche |
| `mcp:playwright` | browser, screenshot, "apri la pagina", click, form, e2e, un URL `localhost`/IP privato | `web_fetch` rifiuta gli indirizzi privati, il browser no |
| `mcp:devtools` | devtools, console, "network requests", performance, trace | |
| `mcp:github` | github, "pull request", `PR #123` | "issue" da sola è troppo generica |
| `mcp:gitlab` | gitlab, "merge request", `MR`, pipeline | |
| `mcp:context7` | context7, "documentazione di <libreria>", "docs for", "latest API" | |
| `mcp:<custom>` | id e nome del server (token di almeno 4 caratteri) | l'utente può impostare *Always* (fase 4) |

- **Comandi built-in:** `/review` porta `git` (spesso si rivedono modifiche locali), `/fix` porta `diagnostics`.
- **Comandi custom:** un frontmatter opzionale `tools: [git, web]` in `.sovran/commands/*.md` dichiara le unità in
  modo esplicito. Il parser resta compatibile: un file senza frontmatter si comporta come oggi.
- **Parole chiave MCP:** nel catalogo come campo `keywords` di `IntegrationDefinition`, non sparse nel router.
- **Errori asimmetrici:**
  - un falso negativo costa un passo in più, perché carica il modello;
  - un falso positivo costa token per tutta la chat, perché il caricamento è sticky;
  - quindi regole larghe per le unità economiche (`diagnostics`, `web`) e strette per quelle costose (MCP,
    `git.remote`).
- **Log:** ogni decisione va nel canale Output di Sovran, per esempio
  `Tools: +git.changes (matched "committa"), +git (implied) · 6 units · ~3.4k tokens`. Serve a tarare le tabelle sui
  casi reali.

### Stato nella sessione

```ts
// src/core/sessions/model.ts
interface Session {
  // …
  /** Units loaded on demand, in load order (core excluded). Missing: derive from the tool calls in history. */
  toolUnits?: string[];
  /** Model the units were chosen for (`providerId/modelId`); a different model triggers pruning. */
  toolUnitsModel?: string;
}
```

- Si normalizza in `FsSessionRepository` come `excludedToolGroups`, con un pattern per gli id.
- **Chat esistenti:** senza `toolUnits`, il primo run ricava le unità dalle chiamate ai tool nella storia visibile
  (`messagesForModel`). Una chat che usava Git lo ritrova caricato.
- **Rewind, retry e modifica di un messaggio:** non toccano `toolUnits`. Un insieme più grande del necessario è
  innocuo, ed evita di cambiare il prefisso.

### Pruning

Si scaricano unità solo quando la cache è già invalidata:

- **dopo una compattazione riuscita** (`AgentRunner.compact`);
- **quando cambia il modello** rispetto a `toolUnitsModel`.

Il nuovo insieme è: soglia di budget del modello corrente, più le unità usate nei messaggi rimasti visibili, più il
router sull'ultimo messaggio. Il cambio Plan/Act cambia già l'array dei tool; `toolUnits` resta com'è, perché un'unità
senza tool in Plan semplicemente non contribuisce.

### Interfaccia (quasi invisibile)

- **Transcript:**
  - `load_tools` e i risultati con `loaded` si piegano nella riga *Explored*, che diventa per esempio
    `Explored · 3 files read · loaded Git`;
  - da soli occupano una riga attenuata `Loaded Git tools`, senza card;
  - il conteggio delle letture non include i caricamenti.
- **Indicatore del contesto:** l'evento `context` riceve una ripartizione `{ system, tools, messages }` e le unità
  caricate. Il tooltip mostra per esempio
  `Tools ~1.5k · Instructions ~0.4k · Conversation ~5.2k · Loaded: Git, Diagnostics`.
- **Settings → Tools:**
  - un interruttore **Load tools when needed** (`sovran.tools.loading`: `auto` / `all`), con una riga di spiegazione;
  - accanto ai gruppi della chat, lo stato *Loaded* o *On demand*;
  - nessun altro controllo nella prima versione.
- **Nessuna nuova approvazione e nessuna notifica.**

### Sicurezza

| Rischio | Mitigazione |
|---|---|
| Una prompt injection convince il modello a caricare tool | Caricare non esegue nulla e non aggira approvazioni, Off, esclusioni o Plan mode. Oggi questi tool sono sempre offerti: l'esposizione non peggiora |
| Un file o un risultato pilota il router | Il router legge solo testo digitato dall'utente e comandi slash (quelli custom solo in workspace trusted) |
| Testo di un server MCP nell'indice | L'indice usa le etichette di Sovran e i nomi dei tool, non le descrizioni o le istruzioni del server |
| Esecuzione di una chiamata non offerta | La chiamata diretta carica e basta. L'esecuzione richiede una nuova richiesta in cui il tool è offerto |
| `load_tools` sostituito da un tool omonimo | Nome riservato nel registro; i nomi MCP hanno il prefisso `mcp__` |

## Esecuzione

Quattro pull request in sequenza, ciascuna con `npm run check` e `npm run build` verdi e una sezione *Verification*.
Effort come in ROADMAP: S, M o L, una persona con pair AI.

### PR 1 · `feat(core): load tools on demand` · M

Contenuto spento di default (`sovran.tools.loading: "all"`): si integra senza cambiare il comportamento.

| File | Modifica |
|---|---|
| `src/core/tools/types.ts` | `unit?: string` su `ToolDefinition` |
| `src/core/tools/builtin/*.ts` | `unit` su ogni tool nativo, come da tabella |
| `src/core/tools/loading.ts` (nuovo) | `unitOf`, `TOOL_UNIT_PATTERN`, `LoadableUnit`, `planLoading` (soglia di budget, ordine, implicazioni `git.changes`/`git.remote` → `git`), `loadToolsSchema`, `unitsFromHistory` |
| `src/core/tools/registry.ts` | nome `load_tools` riservato; nessuna altra modifica: la disponibilità resta una questione di permessi |
| `src/core/agent/agentRunner.ts` | `buildRequest` filtra per unità caricate, accoda le unità in ordine di caricamento, aggiunge `load_tools`; `executeCall` gestisce `load_tools` e la chiamata diretta; il messaggio "Unknown tool" cita le unità; evento `tools_loaded` |
| `src/core/agent/events.ts` | `tools_loaded { units, reason: 'budget' \| 'history' \| 'model' \| 'call' }` |
| `src/core/agent/systemPrompt.ts` | riga statica sul caricamento, solo se `load_tools` è offerto |
| `src/core/sessions/model.ts`, `FsSessionRepository.ts` | `toolUnits`, `toolUnitsModel` e loro normalizzazione |
| `src/core/sessions/model.ts` (`ToolMessage`) | campo opzionale `loaded?: string[]` |
| `src/extension/config.ts`, `package.json` | `sovran.tools.loading` (`auto` \| `all`, scope `application`, default `all` in questa PR) |
| `src/extension/SovranController.ts` | passa la modalità al runner; registra `tools_loaded` nel log |

Test (`tests/unit/toolLoading.test.ts` più casi in `agentRunner.test.ts`, con `ScriptedProvider` che registra le
richieste):

- [ ] Ogni tool nativo ha un'unità valida; `load_tools` non si può registrare.
- [ ] `all`: la richiesta è identica byte per byte a `main` (snapshot di `request.tools` e del system prompt).
- [ ] `auto` con finestra piccola: la prima richiesta contiene nucleo e `load_tools`, con l'enum delle unità
      disponibili in quella modalità.
- [ ] Soglia di budget: tutto, solo native, solo nucleo, in base a finestra e riserva.
- [ ] `load_tools(['git.changes'])` aggiunge `git` e `git.changes`; la richiesta successiva li offre in fondo, e
      l'array precedente è un prefisso del nuovo.
- [ ] Senza caricamenti, system prompt e `tools` sono identici tra i passi dello stesso run.
- [ ] Chiamata diretta a `git_status`: niente esecuzione (nessun processo `FakeProcess`), risultato `success` con
      `loaded`, e la stessa chiamata nel passo dopo viene eseguita.
- [ ] Chiamata diretta a un tool di un gruppo escluso, disabilitato, MCP Off, Restricted Mode o di scrittura in Plan:
      stesso rifiuto di oggi, nessun caricamento.
- [ ] Id inventato in `load_tools`: errore di validazione; unità già caricata: nessun effetto.
- [ ] Modalità prompted: indice e schemi caricati finiscono nelle istruzioni, e la chiamata diretta funziona dai
      blocchi `<tool_call>`.
- [ ] Chat senza `toolUnits`: unità ricavate dalla storia, poi salvate.
- [ ] Il loop guard non conta i caricamenti.

### PR 2 · `feat(core): route tools from the request` · M

| File | Modifica |
|---|---|
| `src/core/tools/routing.ts` (nuovo) | `routeToolUnits`, tabelle EN/IT, implicazioni, unità custom MCP dal nome del server |
| `src/core/mcp/catalog.ts` | `keywords` per ogni integrazione |
| `src/core/commands/slashCommands.ts` | `tools` sui comandi; built-in `/review` → `git`, `/fix` → `diagnostics`; frontmatter `tools:` nei comandi custom |
| `src/core/agent/agentRunner.ts` | router all'inizio del run, motivo `router` in `tools_loaded` |
| `src/extension/SovranController.ts` | log delle decisioni; passa il comando slash al runner |
| `package.json`, `config.ts` | default `sovran.tools.loading: "auto"` |

Test:

- [ ] **Corpus di routing** (`tests/fixtures/routingCorpus.ts`): almeno 80 richieste reali in italiano e inglese,
      ciascuna con le unità attese, incluse quelle che non ne richiedono nessuna ("spiegami questo file").
      Il test calcola precision e recall per unità e richiede:
  - recall ≥ 90% per `git`, `git.changes`, `git.remote`, `diagnostics`, `symbols`, `web`;
  - precision ≥ 90% per le unità MCP e ≥ 75% per le altre.
  - In caso di fallimento stampa la matrice degli errori.
- [ ] Il router ignora allegati e risultati dei tool: un file che contiene "git push" non carica `git.remote`.
- [ ] Frontmatter dei comandi custom: con `tools`, senza, malformato (ignorato con un avviso nel log).
- [ ] Una richiesta che cita `localhost:3000` carica `mcp:playwright` (se configurato) e non `web`.

### PR 3 · `feat(ui): quiet tool loading` · S–M

| File | Modifica |
|---|---|
| `src/shared/protocol.ts` | `ContextUsageView.breakdown`, `ContextUsageView.units`; `ToolGroupView.loading: 'loaded' \| 'on-demand' \| 'always'`; `loaded` sui messaggi dei tool |
| `src/extension/SovranController.ts` | proiezione dell'evento `context` arricchito e dello stato dei gruppi |
| `webview/src/components/Transcript.tsx` | caricamenti nella riga *Explored* e riga attenuata quando sono da soli |
| `webview/src/components/Composer.tsx` | tooltip dell'indicatore con ripartizione e unità caricate |
| `webview/src/components/ToolSettings.tsx`, `Settings.tsx` | interruttore **Load tools when needed** e stato per gruppo |
| `webview/src/dev/mockHost.ts` | scenario `?scenario=tool-loading` per la QA visiva |
| `docs/USER_GUIDE.md`, `docs/ARCHITECTURE.md` (§6, §8), `docs/DECISIONS.md` (ADR-034), `CHANGELOG.md` | documentazione |

Test di componente:

- [ ] Riga *Explored* con un caricamento.
- [ ] Riga isolata.
- [ ] Tooltip dell'indicatore.
- [ ] Interruttore in Settings.
- [ ] Stato *On demand* / *Loaded*.
- [ ] QA visiva a 280 e 400 px in tema chiaro e scuro.

### PR 4 · `feat(core): leaner tool context` · S

- Pruning dopo la compattazione e al cambio di modello, come descritto sopra, con test.
- Schemi inviati senza vincoli di sola validazione (−11%), con uno snapshot prima/dopo e la validazione zod
  invariata.
- `maxToolResultChars` effettivo uguale al minimo tra l'impostazione e circa il 15% del budget del modello, con un
  test per finestre da 8k, 32k e 128k.

### Dopo

Fuori da queste PR, da valutare con i dati raccolti:

- Opzione *Always load* per singolo server MCP.
- Caricamento per singolo tool con ricerca lessicale (`load_tools({ query })`), per server con decine di tool.
- Avvio pigro dei server MCP stdio al primo caricamento, per risparmiare memoria.
- Router assistito da un modello piccolo (lo stesso dei titoli), confrontato con il router a regole sullo stesso
  corpus.

## Criteri di accettazione

1. In Act con finestra da 32k e nessun MCP, la prima richiesta stima al massimo ~1.600 token di definizioni (oggi
   ~4.850).
2. Un server MCP non caricato costa solo la sua riga nell'indice.
3. Con `all`, oppure quando tutto sta nella soglia di budget, le richieste sono identiche a `main`.
4. Senza nuovi caricamenti, il prefisso (system prompt e `tools`) è identico tra i passi; dopo un caricamento,
   l'array precedente è un prefisso del nuovo.
5. Sul corpus il router rispetta le soglie della PR 2. Nei task reali la mediana dei passi in più dovuti al
   caricamento è 0, e il massimo è uno per unità per chat.
6. Nessun tool diventa eseguibile in un caso in cui oggi non lo è. I test di disponibilità esistenti
   (`toolAvailability.test.ts`) passano invariati.

## Verifica manuale sui due setup

Da ripetere con `all` e con `auto` sul Mac (modello locale piccolo, finestra da 32k) e su Linux (GLM dietro APISIX).
Il prompt reale si legge dall'evento `usage` del server, mostrato nell'indicatore del contesto e nel log.

| # | Richiesta | Unità attese |
|---|---|---|
| 1 | "Spiegami cosa fa questo file" con file attivo | nessuna |
| 2 | "Perché non compila?" | `diagnostics` |
| 3 | "Dove viene usata questa funzione?" | `symbols` |
| 4 | "Rinomina questa funzione in tutto il progetto" | `symbols` |
| 5 | "Scrivi un test e lancialo" | nessuna |
| 6 | "Committa le modifiche con un messaggio sensato" | `git`, `git.changes` |
| 7 | "Fai push del branch" | `git`, `git.remote` |
| 8 | "Leggi https://… e riassumi" | `web` |
| 9 | "Apri localhost:3000 e controlla il form" (con Playwright) | `mcp:playwright` |
| 10 | Follow-up "ok, ora fai anche il commit" dopo la 3 | `git.changes` aggiunta, `symbols` resta |

Per ogni riga si registrano:
- token del prompt della prima richiesta;
- passi in più dovuti al caricamento;
- tempo al primo token nel passo dopo un caricamento, per misurare il costo reale dell'invalidazione della cache
  sul Mac;
- se il server restituisce una chiamata a un tool non offerto. Per provarlo, chiedere esplicitamente di usare
  `git_status` prima che `git` sia caricato.

I risultati vanno in `docs/plans/2026-11-13-on-demand-tools-status.md`.

## Rischi

| Rischio | Probabilità | Mitigazione |
|---|---|---|
| Il modello piccolo ignora `load_tools` e risponde senza tool | Media | Router, indice nella descrizione con enum, chiamata diretta; misura sul punto 5 dei criteri |
| Un caricamento sul Mac costa un prefill completo percepibile | Alta, ma una volta per unità | Caricamento sticky e accodato; pruning solo a cache già invalidata; misura del tempo al primo token |
| Il server scarta chiamate a nomi non offerti | Bassa | Fallback del `TaggedStreamParser`; il modello può sempre usare `load_tools` |
| Falsi positivi del router su MCP costosi | Media | Regole strette, corpus con soglia di precision al 90%, log delle decisioni |
| Le tabelle italiane e inglesi invecchiano | Media | Tabelle dichiarative e corpus: un nuovo caso è una riga in più |
| I caricamenti consumano `maxIterations` | Bassa | Al massimo uno per unità; il router evita la maggior parte dei casi |

## Decisioni aperte

1. **Soglia di budget al 10%** del budget di input. È un compromesso tra round-trip e accuratezza nella scelta del
   tool: andrà tarata con le misure sul GLM.
2. **Git in tre unità** invece di una sola. Consigliato: in Plan servono solo le letture, e push/rebase sono rari.
3. **Default `auto` dalla PR 2.** Consigliato, perché `all` resta come via d'uscita.
