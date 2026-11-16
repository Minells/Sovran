# Code Mode — stato del prototipo

16 novembre 2026. Branch `feat/code-mode-prototype`, creato da `origin/main` al commit `2e4bc32`.

**Stato: prototipo tecnico implementato e verificato su Linux; validazione con modelli reali ancora aperta.**
La feature rimane sperimentale, spenta per default e attivata esplicitamente tramite `/code`.
Il [piano](2026-11-16-code-mode-prototype.md) mantiene le soglie di prodotto: questo rapporto non le considera
raggiunte sulla base di risposte del modello simulate.

## Implementazione

- Esecutore autorizzato estratto in `src/core/tools/executor.ts`: condiviso fra tool diretti e chiamate del sandbox.
  Prepare, policy, approvazioni, trust, disponibilità, esclusioni per chat e ricontrollo prima del dispatch restano
  nello stesso percorso. Sono preservati i test del comportamento standard.
- `code_search`, `code_describe`, `execute_code`, con ricerca locale e manifest host legati a un run e alle precise
  definizioni descritte. Describe ed execute nella stessa risposta non concedono nuove capacità a codice già scritto.
- Argomenti Code Mode in JSON rigoroso, anche nel percorso prompted: nessuna riparazione automatica che possa
  alterare i letterali JavaScript. Il parser standard conserva il comportamento precedente.
- QuickJS/WASM 0.32.0, sola variante release sincrona con Promise guest, dentro Worker fresco per ogni job.
  Il loader Emscripten CommonJS è risolto esplicitamente nel bundle; nessun download sul computer dell'utente.
- Sandbox lazy, senza riferimenti a Node, VS Code, filesystem, rete diretta, librerie o credenziali dell'host.
  Timeout, interrupt, limiti heap/stack, coda, concorrenza, chiamate, messaggi e output sono definiti nel codice host.
- Sottoinsieme revisionato dei tool dei profili managed readonly GitHub/GitLab. Annotazioni `readOnlyHint` di un
  server custom non abilitano il prototipo. Non sono aggiunti tool ai profili già esistenti.
- Ajv 8.18.0 per un sottoinsieme limitato di JSON Schema: niente refs, regex, coercizione, default applicati o
  caricamenti remoti. Gli schemi non supportati escludono il tool anziché indebolire la validazione.
- Risultati MCP strutturati preservati solo quando il dispatcher richiede il percorso Code Mode. Il risultato
  testuale delle chiamate standard mantiene il contratto precedente.
- Traccia UI delle chiamate figlie e codice ispezionabile; risultati parziali distinti. Nessun messaggio tool fittizio
  per il provider e nessuna aggiunta dei dataset intermedi al transcript o alla compattazione.
- Setting letto solo dalle impostazioni utente. La disabilitazione live e la revoca delle capacità bloccano anche
  dispatch precedentemente in attesa di approvazione. Approvazioni serializzate per chat.

Le dipendenze aggiunte sono `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` e Ajv. Notices generate
anche per il motore incorporato nel WASM. TypeScript ed esbuild non diventano compilatori richiesti al runtime.

## Verifiche eseguite

Ambiente: Linux x86_64, Node 22.23.5 per i controlli finali, quota di circa 2 CPU e 8 GiB di RAM.

| Controllo | Risultato |
|---|---|
| Baseline prima delle modifiche | 755 test passati, 2 saltati; checkout `2e4bc32` |
| `npm run check` finale | Typecheck e lint puliti; **795 test passati, 2 saltati**, 41 file passati e 1 saltato |
| `npm run build` | Host e webview costruiti correttamente |
| Worker QuickJS reale | 18 test: async/Promise, RPC, isolamento, import/Node/rete assenti, loop, microtask, memoria, cancellazione, cleanup, output e deadline |
| Limite memoria | Allocazione guest da 80 MiB rifiutata dal limite QuickJS da 64 MiB |
| MCP + agent + QuickJS | Native e prompted; aggregazione corretta di 11 chiamate fra due server |
| Paginazione | 24 chiamate, tutte le pagine progetti/pipeline considerate, conteggio corretto |
| Guasto parziale | Un progetto non disponibile resta esplicito; conteggio disponibile 18, stato partial, niente zero inventato |
| Permessi | Rifiuto anche in Auto, nessun dispatch dopo revoca durante approvazione, gate Plan/trust/setting/tool mode |
| Scala discovery | 100 tool mock revisionati nel registry; 10 server MCP reali in memoria che pubblicizzano 10 tool ciascuno, con esclusione dei tool non revisionati |
| UI | Codice e chiamate figlie, sostituzione dei progressi senza accumulo, argomenti malformati renderizzati come testo |
| VS Code Linux 1.146.0 | Smoke dell'estensione passati, compreso Worker QuickJS con WASM locale |
| VS Code Linux 1.95.0 | Stessi smoke passati sulla versione minima supportata |
| VSIX installato in profilo pulito | Smoke passati; Worker e WASM caricati dal pacchetto installato |
| `verify:vsix` | 31 file, asset necessari presenti, nessun bundle di server/browser o `node_modules` |
| Trivy sui tre lockfile aggiornati | 0 vulnerabilità note rilevate, database del 16 novembre 2026, dev dependencies incluse |

La scansione dei lockfile non è un audit del codice del sandbox o un'analisi completa del binario WASM.
Non sono stati eseguiti test su Windows, macOS Intel o Apple Silicon in questa VM Linux.

## Misure del riferimento riproducibile

Comando: `npm run benchmark:code-mode -- --reference --runs 3`.
Dataset sintetico: 10 progetti, 6 pipeline ciascuno, due server MCP in memoria. Stessi dati e policy sui due percorsi.
Il baseline `auto` raggruppa le richieste indipendenti nella stessa risposta; non gli si impone una inferenza per tool.
Le risposte del provider sono prescritte: questo misura collegamenti, volume e overhead, **non il ragionamento LLM**.

Mediane sulle tre ripetizioni native:

| Misura | Standard `auto` | Code Mode | Interpretazione |
|---|---:|---:|---|
| Inferenze simulate | 3 | 3 | Nessuna riduzione su questo caso |
| Chiamate MCP | 11 | 11 | Stesso lavoro richiesto ai server |
| Byte di risultati intermedi ripetuti nelle richieste | 68.200 | 2.019 | −97,0%, discovery inclusa |
| Byte totali delle richieste | 82.873 | 13.942 | −83,2% |
| Stima input + output, byte/3,5 | 23.742 | 4.246 | −82,1%; non token fatturati né tokenizer reale |
| Tempo con provider simulato | 12 ms | 105 ms | Il runtime aggiunge overhead quando il modello non costa tempo |

Dieci avvii di Worker freschi nello stesso processo: mediana 52 ms, p95 68 ms. Questo non misura l'intera attivazione
di VS Code e non dimostra la latenza di un task con modello. Anche il riferimento prompted ha completato entrambi i
percorsi correttamente. Il corpus dei benchmark attuali copre un task; la matrice di prodotto da dodici task resta aperta.

Dimensioni VSIX misurate da build dello stesso commit base e del prototipo, con lo stesso ambiente:

- `main`: 1.299.679 byte.
- Prototipo: 1.601.609 byte.
- Incremento: **301.930 byte**, circa 295 KiB compressi, entro il budget proposto di 2 MiB aggiuntivi.

## Come provare

La [guida](../USER_GUIDE.md#experimental-code-mode) contiene attivazione, sottoinsieme dei tool e limiti.
Il comando di riferimento richiede solo dipendenze di sviluppo e build, senza account remoti.

Per un vero endpoint già disponibile:

```bash
npm run benchmark:code-mode -- --endpoint http://127.0.0.1:8080/v1 --model MODEL_ID \
  --tool-mode prompted --runs 3 --out /tmp/sovran-code-model.json
```

Il test usa il provider e il runner del prodotto con gli MCP sintetici, quindi non legge repository privati.
Per un endpoint autenticato usare `SOVRAN_BENCHMARK_API_KEY` tramite il meccanismo di segreti dell'ambiente.

## Cosa manca per i gate di prodotto

1. **Modello reale.** Nessun endpoint alternativo o segreto è configurato. Questa VM può ospitare una prova CPU con
   un modello piccolo quantizzato, ma `huggingface.co` è bloccato dalla policy. Servono il dominio e gli eventuali
   host precisi dei redirect per scaricare i pesi. Il modello non è stato scaricato né eseguito.
2. **Qualità rappresentativa.** Un modello da 0,5–1,5B può verificare il percorso, ma non sostituisce la matrice con
   il modello locale e quello dietro gateway effettivamente usati dagli utenti. Misurare anche errori, retry, cache,
   paginazione, guasti parziali e approvazioni umane. Il target −30% inferenze non è dimostrato da questo riferimento.
3. **MCP reali.** Servono endpoint/accesso ai profili readonly GitHub/GitLab per verificare gli schemi e i contenuti
   effettivi. Lo SDK reale in memoria non prova compatibilità con ogni versione dei server ospitati.
4. **Altri OS.** Eseguire CI/smoke su Windows e sulle due architetture macOS prima di dichiararli verificati.

Restano esclusi TypeScript, scritture, tool nativi dentro il sandbox, server arbitrari, stato persistente e Auto.
Il resto dell'agente Act mantiene le autorizzazioni native esistenti; il perimetro readonly riguarda le capacità del
sandbox. I limiti di heap non sono un tetto all'intera memoria di processo; i limiti delle risposte non sono un limite
di traffico prima del parsing SDK; cancellazione remota best effort. Vedere anche [SECURITY](../../SECURITY.md).

**Decisione attuale:** pronto per prove tecniche controllate su Linux. Mantenere opt-in; non pubblicizzare ancora
accelerazioni LLM, risparmi di token reali o equivalenza di qualità. Prossimo passo: modello disponibile e benchmark
di prodotto, quindi decisione informata su beta o restringimento del perimetro.
