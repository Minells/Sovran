# Caricamento dei tool su richiesta — stato

Implementazione del [piano](2026-11-13-on-demand-tools-plan.md) sul branch `feat/on-demand-tools`, un commit per fase:

| Fase | Commit | Contenuto |
|---|---|---|
| 1 | `feat(core): load tools on demand` | Unità, `load_tools`, chiamata diretta, stato per chat, soglia di budget, impostazione `sovran.tools.loading` |
| 2 | `feat(core): route tools from the request` | Router EN/IT, comandi slash con unità, front matter `tools:`, corpus di routing, default `auto` |
| 3 | `feat(ui): quiet tool loading` | Riga *Explored*, riga discreta, ripartizione nell'indicatore del contesto, stato per gruppo, interruttore in Settings, documentazione |
| 4 | `feat(core): leaner tool context` | Unità scelte di nuovo dopo compattazione o cambio di modello, schemi senza vincoli inutili, limite dei risultati proporzionale alla finestra |

## Evidenze automatiche

Misurate in questo ambiente (Node 22, Ubuntu 24.04).

| Controllo | Risultato |
|---|---|
| `npm run typecheck`, `npm run lint` | Puliti |
| `npm run build` | Pulito, senza warning; webview 610 kB (budget 650 kB) |
| Test | 741 in totale. Falliscono solo 44 test di integrazione Git, già falliti su `main` (`e272af7`): il Git dell'ambiente (2.43) non supporta `--no-lazy-fetch`. L'insieme dei test falliti è identico a quello di `main` dopo ogni fase |
| Nuovi test | `toolLoading.test.ts` (35), `toolRouting.test.ts` (18 + corpus), test host in `hostMcp.test.ts` e `surfaces.test.ts`, test di componente in `App.test.tsx`, front matter in `wave1.test.ts` |
| Test di estensione in VS Code reale | Non eseguiti qui (il download di VS Code non è disponibile); `tests/extension/suite.cjs` verifica default e scope del nuovo setting e gira in CI |

### Token delle definizioni dei tool nativi

Stima di Sovran (3,5 caratteri per token) sulle definizioni serializzate, workspace trusted, nessun MCP.

| | `main` | Questo branch, tutto caricato | Prima richiesta con caricamento su richiesta |
|---|---|---|---|
| Act | 27 tool, ~4.850 | ~4.520 (−7%, schemi snelli) | nucleo ~1.260 + `load_tools` ~175 = **~1.430 (−70%)** |
| Plan | 16 tool, ~2.970 | ~2.780 | nucleo ~680 + `load_tools` ~140 = **~820 (−72%)** |

Costo delle unità caricabili (Act): `git` ~1.140, `git.remote` ~650, `symbols` ~525, `git.changes` ~515, `diagnostics`
~270, `web` ~160. Ogni server MCP costa solo una riga dell'indice finché non viene caricato.

### Router

Sul corpus di 95 richieste (`tests/fixtures/routingCorpus.ts`) le discordanze erano 4 alla prima esecuzione, ora sono
0. Le quattro correzioni sono di principio: "non committate" è un aggettivo, "con il remoto" ha un articolo,
"then commit" è un imperativo dopo un connettivo, "warning" da solo è lessico di interfaccia. Il corpus però è stato
scritto insieme alle regole: la vera misura sono le richieste reali. Ogni errore osservato va aggiunto al corpus.

## Scostamenti dal piano

- **Un branch, un commit per fase**, invece di quattro pull request.
- **I tool Git sono 12**, non 13: `git` 5, `git.changes` 3, `git.remote` 4.
- **Parole chiave MCP nel router** (`INTEGRATION_RULES: Record<IntegrationId, RegExp>`) invece di un campo `keywords`
  nel catalogo. Così il compilatore obbliga a decidere le parole chiave per ogni nuova integrazione, e il catalogo, che
  viene proiettato nella webview, non contiene espressioni regolari.
- **Schemi snelli senza perdita di informazioni (−7%)** invece di togliere tutti i vincoli (−11%). Limiti come
  `maximum: 50` restano, perché dicono al modello qualcosa che gli evita un errore e un passo in più.
- **Pruning anche dopo `/compact` manuale.** `Session.toolUnitsBasis` registra modello e confine di compattazione; se
  cambiano, il primo run successivo sceglie di nuovo le unità.
- **Gli URL locali vanno al browser** (`mcp:playwright` se configurato), non a `web_fetch`, che li rifiuta comunque.

## Verifica manuale da fare

Sul Mac (modello locale piccolo, finestra da 32k) e su Linux (GLM dietro APISIX), una volta con
`sovran.tools.loading: auto` e una con `all`. Il canale Output *Sovran* registra ogni caricamento con il motivo
(`Tools loaded (router) · git.changes: "Committa"`). L'indicatore del contesto mostra i token riportati dal server e,
nel tooltip, la ripartizione stimata.

| # | Richiesta | Unità attese | `auto` | `all` |
|---|---|---|---|---|
| 1 | "Spiegami cosa fa questo file" con file attivo | nessuna | [ ] | [ ] |
| 2 | "Perché non compila?" | `diagnostics` | [ ] | [ ] |
| 3 | "Dove viene usata questa funzione?" | `symbols` | [ ] | [ ] |
| 4 | "Rinomina questa funzione in tutto il progetto" | `symbols` | [ ] | [ ] |
| 5 | "Scrivi un test e lancialo" | nessuna | [ ] | [ ] |
| 6 | "Committa le modifiche con un messaggio sensato" | `git`, `git.changes` | [ ] | [ ] |
| 7 | "Fai push del branch" | `git`, `git.remote` | [ ] | [ ] |
| 8 | "Leggi https://… e riassumi" | `web` | [ ] | [ ] |
| 9 | "Apri localhost:3000 e controlla il form" (con Playwright) | `mcp:playwright` | [ ] | [ ] |
| 10 | Dopo la 3: "ok, ora fai anche il commit" | aggiunge `git.changes`, `symbols` resta | [ ] | [ ] |

Per ogni riga annota:

- i token del prompt della prima richiesta;
- i passi in più dovuti al caricamento (obiettivo: mediana 0, al massimo uno per unità per chat);
- il tempo al primo token nel passo dopo un caricamento, per misurare il costo dell'invalidazione della cache sul Mac;
- se il server restituisce una chiamata a un tool non ancora offerto. Per provarlo, chiedi esplicitamente di usare
  `git_status` in una chat nuova con un messaggio che non parli di Git: deve comparire *loaded Git* e poi il risultato.

Controlli aggiuntivi:

- [ ] **Settings → Tools → Load tools when needed** spento: le richieste contengono tutti i tool e niente `load_tools`.
- [ ] Un comando custom con `tools: [git.changes]` nel front matter carica i tool di commit alla prima richiesta.
- [ ] Dopo `/compact`, il log mostra `Tools unloaded` per le unità non più usate.
- [ ] Cambiando modello in una chat, le unità non usate vengono scaricate e quelle usate restano.
- [ ] Con un modello in modalità prompted, `load_tools` compare nelle istruzioni e funziona dal blocco `<tool_call>`.
