# Code Mode — piano del prototipo

**Stato: proposta, non implementato.** Analisi del checkout `2e4bc32`, 16 novembre 2026.
Questo documento definisce un esperimento di prodotto con criteri di uscita, non il rilascio completo di Code Mode.
Le soglie indicate sono obiettivi da verificare: non sono risultati già misurati o garanzie di isolamento.

## 1. Decisione e ipotesi da verificare

Introdurre un percorso opzionale nel quale il modello scrive JavaScript per interrogare un insieme limitato di
tool MCP, elaborarne i risultati e restituire una risposta compatta. Il programma viene eseguito in QuickJS/WASM
in un Worker dedicato; le chiamate passano attraverso l'esecutore autorizzato di Sovran e le connessioni MCP esistenti.

**Ipotesi:** sui task con paginazione, filtri, conteggi e confronti fra servizi, l'elaborazione locale dei risultati
riduce il contesto consumato e i passaggi attraverso il modello senza peggiorare la correttezza.

Il confronto principale è con **Sovran attuale, `sovran.tools.loading: auto`**, non con tutti gli schemi sempre esposti.
Il caricamento su richiesta esiste già. Code Mode deve dimostrare un beneficio ulteriore.

Non assumiamo che diminuiscano il numero di chiamate alle API esterne o il tempo dei servizi MCP. Il programma può
fare le stesse richieste e risparmiare soprattutto generazione del modello, prefill e trasferimento di risultati
intermedi. Anche il percorso attuale permette più tool call per risposta, pur eseguendole sequenzialmente.

## 2. Benefici attesi e misura del successo

| Beneficio | Cosa misuriamo | Obiettivo iniziale sui task di aggregazione |
|---|---|---|
| Meno dati nel contesto | Byte e token stimati dei risultati tool effettivamente inviati al modello, discovery inclusa | Mediana almeno −50% rispetto ad `auto` |
| Meno costo complessivo del modello | Somma dei token di input e output di tutte le inferenze, discovery, codice, retry e risposta finale inclusi | Mediana almeno −25% |
| Meno passaggi di orchestrazione | Numero di richieste al modello fino alla risposta corretta, recuperi dagli errori inclusi | Mediana almeno −30% |
| Risposte affidabili | Correttezza rispetto a risultati attesi e copertura delle pagine | Almeno 90% e nessun task riuscito in meno del baseline nella matrice primaria |
| Tempo utile | Tempo fino alla risposta corretta; attese MCP e approvazioni separate | Mediana non peggiore di oltre il 10% |
| Controllo invariato | Policy, esclusioni, revoche, Stop, schema e tracciamento delle chiamate | Tutti i test obbligatori passano |

Le soglie sono fissate prima delle prove e non si modificano dopo aver visto i risultati senza dichiararlo.
I confronti percentuali si calcolano sui task risolti correttamente da entrambi i percorsi; fallimenti e timeout
restano nel conteggio di affidabilità e hanno una tabella separata. Un errore veloce non conta come risparmio.

I token reali del provider hanno precedenza quando disponibili. La stima corrente di Sovran, a caratteri per token,
va etichettata come stima. Riportare anche byte e inferenze per non dipendere da un tokenizer o dall'endpoint.
Registrare eventuali token in cache separatamente: input ripetuto e costo di prefill non sono la stessa misura.

**Decisione dopo le prove:**

- Tutte le soglie e i controlli passano: mantenere la feature sperimentale e pianificare una beta limitata.
- Il beneficio esiste solo su un modello o tipo di task: mantenere il perimetro esplicito e documentarlo.
- Qualità o sicurezza non passano: correggere il problema o fermare il prototipo; niente attivazione automatica.
- Risparmio trascurabile rispetto ad `auto`: non estendere il runtime; valutare discovery più precisa o aggregazioni
  specifiche senza esecuzione di codice.

## 3. Perimetro della prima versione

### Incluso

- JavaScript moderno, asincrono, con corpo di funzione e `return` finale; niente TypeScript eseguibile.
- QuickJS/WASM con nuova istanza di runtime e context per ogni esecuzione, dentro un Worker terminabile.
- Discovery in tool separati, eseguita prima della generazione del programma.
- Chiamata generica `tools.call(toolId, args)`: niente SDK con un namespace per ogni server.
- Soltanto tool MCP di lettura selezionati e revisionati nel codice di Sovran.
- Risultati JSON e testo, errori distinti, filtri, aggregazioni e paginazione esplicita.
- Policy MCP Off / Ask / Allow, workspace trust, esclusioni per chat e controlli live esistenti.
- Stop, timeout, limiti di chiamate, concorrenza e dimensione dei messaggi.
- Traccia locale delle singole chiamate visibile all'utente; al modello arriva il risultato finale compatto.
- Test con MCP in memoria e prova end-to-end con almeno un modello locale e uno dietro gateway.

### Escluso

- Scritture, cancellazioni, commenti, creazione o modifica di issue/PR, merge, commit e deploy dal sandbox.
- Terminale, file del workspace, strumenti nativi, browser, rete diretta, moduli Node o pacchetti del progetto nel sandbox.
- Import, dynamic import, `require`, installazione di librerie o download di codice.
- Server MCP arbitrari ammessi solo perché dichiarano `readOnlyHint`.
- Generazione completa di tipi TypeScript o validazione statica del programma.
- Auto-selezione della strategia, nuovo agent loop, scheduler generale dei tool normali.
- Stato del programma fra esecuzioni, filesystem virtuale persistente, cache dei dataset e riferimenti a risultati recuperabili.
- Elaborazione di immagini/audio/binari; i relativi contenuti diventano etichette limitate.
- Promesse di isolamento del sistema operativo, prevenzione completa della prompt injection o rollback remoto.
- Nuove integrazioni MCP o ampliamenti automatici di profili, scope dei token e permessi.

Il programma gira sul computer dove gira l'Extension Host: anche remoto in SSH, container di sviluppo o Codespaces.
Non richiede un nuovo servizio cloud, Docker o un runtime installato manualmente. I server MCP possono comunque
contattare servizi remoti, come già oggi.

## 4. Cosa riutilizziamo e cosa manca

| Componente attuale | Riutilizzo | Intervento necessario |
|---|---|---|
| `src/core/tools/registry.ts` | Registro, provenienza, identità delle definizioni e disponibilità live | Vista filtrata per i soli tool ammessi al prototipo |
| `src/core/tools/loading.ts` | Percorso standard e baseline `auto` | Vista di offerta alternativa solo per il run esplicito Code Mode |
| `src/core/agent/agentRunner.ts` | Loop, provider, limiti di iterazione e transcript | Estrarre dispatch autorizzato; integrare i tre tool di orchestrazione |
| `src/core/permissions/policy.ts` | Autorità per le decisioni di esecuzione | Nessuna policy parallela per Code Mode |
| `src/core/mcp/hub.ts` | Connessioni, lifecycle, tool, cancellazione SDK | Accesso a metadati originali e risultati strutturati, senza nuove connessioni |
| `src/core/mcp/results.ts` | Rendering testuale del percorso normale | Separare dati MCP e presentazione senza cambiare il rendering esistente |
| `src/core/mcp/catalog.ts` | Profili e tool già revisionati | Piccola allowlist specifica, eventualmente vincolata anche agli argomenti |
| `src/extension/adapters/WorkerDocumentConverter.ts` | Pattern di Worker, timeout e terminazione | Adattatore distinto per QuickJS e RPC a più messaggi |
| `src/core/ports.ts` | Separazione core/host | Port di esecuzione del sandbox, senza dipendenze VS Code nel core |
| `tests/fixtures/mcp.ts` | SDK reale e trasporti in memoria | Fixture con dataset, ritardi, pagine, errori e schemi di output |
| `scripts/build-host.mjs`, `.vscodeignore`, `scripts/verify-vsix.mjs` | Build e verifica distributabile | Worker, WASM, notices e smoke del VSIX installato |

Non ricostruire un secondo registry, client MCP, sistema di grant o agent loop.

## 5. Attivazione ed esperienza utente

Proposta: setting utente `sovran.experimental.codeMode.enabled`, default `false`, letto solo dalle impostazioni
utente. Un repository non può attivarlo tramite `.vscode/settings.json`.

Con il setting attivo, `/code <richiesta>` seleziona il percorso per quel run. Le richieste normali mantengono il
comportamento attuale. Serve Act e un workspace trusted; Plan, Restricted Mode e provider con tool mode `none`
ricevono una spiegazione senza eseguire il programma. Native e prompted tool calling restano percorsi supportati,
ma l'affidabilità dei modelli si misura separatamente.

Durante il run:

1. La UI indica che è attiva la sperimentazione Code Mode.
2. La discovery mostra attività sintetica senza stampare tutti gli schemi nel pannello.
3. L'esecuzione ha una riga espandibile con codice, contatore delle chiamate e stato.
4. Ogni chiamata MCP ha server, tool, durata, stato e l'eventuale approvazione usuale con gli argomenti.
5. Stop termina il programma, svuota la coda e segnala richieste remote dall'esito non ancora noto.

Le approvazioni si mostrano una alla volta per chat, anche quando il programma usa `Promise.all`.
Non compare un pulsante «approva tutto il programma». Il consenso al codice non autorizza implicitamente i tool.
Con Ask restano possibili molte conferme: il prototipo deve mostrarne il costo, senza nasconderlo.

La traccia delle chiamate interne usa eventi e metadati associati alla chiamata esterna, non falsi messaggi tool
con ID che il provider non ha emesso. Persistono metadati limitati per la diagnosi; i dataset intermedi non vengono
aggiunti al transcript, al sommario della chat o ai log. Il codice compare già negli argomenti del tool: rendere
esplicito che anche i suoi letterali possono contenere dati e seguire il comportamento di persistenza della chat.

Nessun retry o fallback automatico all'intero task standard dopo un errore. Il modello può correggere il codice
entro i budget, oppure spiegare il limite. Tornare al percorso normale è una scelta esplicita su un nuovo run.

## 6. Discovery e contratto di esecuzione

### Tre tool di orchestrazione

| Tool | Input indicativo | Risultato |
|---|---|---|
| `code_search` | `{ query, limit? }` | Fino a 8 riepiloghi: ID, server, nome e descrizione breve |
| `code_describe` | `{ toolIds }`, massimo 8 | Schemi pertinenti e un `manifestId` generato dall'host |
| `execute_code` | `{ manifestId, code }` | Valore finale JSON, stato e contatori limitati |

Nomi da riservare e verificare contro le regole del registry. Sono tool di orchestrazione, non un'autorizzazione
generica a usare risorse dell'host. Discovery non esegue tool MCP. Il wrapper di esecuzione non chiede un'approvazione
generica ridondante: applica gating Act/trust/setting e ogni chiamata figlia attraversa l'esecutore autorizzato.
L'integrazione deve essere esplicita, come quella del tool virtuale `load_tools`; non etichettare tutto come `read`
per aggirare i controlli.

Ricerca locale deterministica per nome, server e descrizione, senza embedding né inferenze aggiuntive. Descrizioni
trattate come contenuto esterno, limitate e separate dalle istruzioni. Nessuna promessa di riconoscere ogni parafrasi.
Gli schemi sono dati; non si interpolano nomi o descrizioni MCP in codice eseguibile.

### Manifest delle capacità

Il manifest è memorizzato dall'host, associato a chat, run e precise definizioni/versioni dei tool descritti.
Il suo ID non è una credenziale MCP e non concede privilegi: restringe ciò che il programma può richiamare.

- `execute_code` è ammesso solo se il manifest era già disponibile quando è stata costruita la richiesta al modello.
  Non basta indovinare un ID o accodare describe ed execute nella stessa risposta senza averne letto il risultato.
- Ogni RPC usa il sottoinsieme del manifest e ricontrolla policy e disponibilità attuali prima del dispatch.
- Reconnect, sostituzione dello schema/definizione, revoca, Stop o cambio di trust invalidano la capacità pertinente.
- Al termine del run, riavvio, cambio modello o compattazione non si riusano manifest: la discovery va rifatta.
- Chiamare un tool non descritto è un errore, senza autocaricamento o ampliamento del manifest.

Si conserva così l'intento dell'invariante attuale «definizione offerta prima dell'esecuzione», adattandolo al fatto
che il modello riceve lo schema via discovery. Non basta risolvere un nome nel registry.

Nel run Code Mode gli schemi MCP diretti e le relative unità di `load_tools` non sono offerti, nemmeno se erano
stati caricati prima nella chat. La vista alternativa non elimina o riscrive `session.toolUnits`: al run standard
successivo si ripristina il percorso esistente. I tool nativi mantengono la propria politica di offerta, ma non sono
raggiungibili dal sandbox. I manifest e gli indici non vengono aggiunti dinamicamente al system prompt.

### API del programma

```js
// Corpo di funzione asincrona; tools è fornito dal sandbox.
const result = await tools.call("ID_ottenuto_dalla_discovery", { project_id: "123" });
if (result.data === undefined) throw new Error("Il tool non ha restituito dati JSON");
// Elaborazione basata sul contratto realmente descritto, non su una struttura inventata.
return { result: result.data };
```

L'esempio spiega soltanto il contratto: i benchmark devono restituire sintesi, non riversare i dataset al modello.
`tools.call` restituisce un envelope documentato `{ data?, text?, contentTypes }`; l'output resta `unknown` quando
non esiste uno schema. Gli errori MCP rifiutano la Promise con codice e messaggio limitato. `isError` non viene
trasformato in una lista vuota o in un conteggio zero.

- Preservare `structuredContent` anche quando esistono blocchi testuali.
- In assenza di contenuto strutturato, accettare come `data` un singolo blocco testo interamente JSON valido.
  Niente estrazione euristica di oggetti da prosa o esecuzione del testo ricevuto.
- Altrimenti restituire solo `text`: il task può risultare non adatto al prototipo.
- Non restituire URI locali, immagini o risorse binarie come accessi impliciti a file o rete.
- Il codice è avvolto dall'host in una funzione asincrona; non si presume che un `return` al livello principale sia
  JavaScript valido. Loader dei moduli assente e nessun riferimento a oggetti host.

## 7. Dispatcher condiviso e bridge MCP

Estrarre dal runner il percorso di validazione, preparazione, decisione, approvazione, ricontrollo ed esecuzione.
Il runner mantiene costruzione delle richieste, caricamento, conversazione, compattazione e ciclo del modello.
Il dispatcher restituisce un esito interno; non aggiunge da solo messaggi al modello.

Il percorso standard conserva la verifica della mappa `offered`. Code Mode fornisce una capacità derivata dal
manifest. Nessun parametro pubblico «skipApproval» o «skipAvailability» e nessun accesso RPC diretto a `hub.callTool`.

Per ogni chiamata interna, nell'ordine:

1. Validare formato RPC, identità dell'esecuzione e ID univoco non riusato; controllare budget e dimensione.
2. Risolvere il tool nel manifest host e verificare che sia ancora la stessa definizione.
3. Applicare allowlist del prototipo, eventuali vincoli sugli argomenti, gruppi esclusi, trust e policy live.
4. Validare gli argomenti con lo schema MCP originale, non con lo schema eventualmente semplificato per il prompt.
5. Eseguire prepare e decisione con l'autorità di permesso esistente.
6. Se necessario, attendere l'approvazione reale per quella chiamata; il guest non può rispondere alla richiesta.
7. Ripetere controllo live dopo approvazione e attesa nella coda, immediatamente prima del dispatch.
8. Chiamare il tool attraverso il percorso MCP esistente con segnale e timeout residuo.
9. Normalizzare risultato/errori, mascherare credenziali note e applicare i limiti prima di trasferire al Worker.
10. Aggiornare traccia, budget e stato; consegnare la risposta soltanto se l'esecuzione è ancora attiva.

Una negazione, una revoca o un errore di protocollo invalidano l'esecuzione: catturare l'eccezione nel programma
non abilita altre chiamate. Un normale errore applicativo MCP può invece essere gestito con `try/catch` o
`Promise.allSettled`, restando visibile nella traccia. `Promise.all` fallita non annulla magicamente richieste già
inviate: la chiusura del job deve cancellarle dove possibile e registrarle.

### Schemi e validazione

Oggi lo schema Zod degli argomenti MCP controlla soprattutto che siano un oggetto; non sostituisce la validazione
completa dell'input JSON Schema. La validazione del nuovo bridge è pertanto un'aggiunta da progettare e testare.

Usare un validatore JSON Schema mantenuto e compatibile MIT, preferendo quello già riutilizzabile nello SDK se
espone le API necessarie; altrimenti valutare Ajv. Bloccare versione e opzioni durante la fase iniziale.
Niente caricamento di `$ref` remoti, mutazione/coercizione automatica degli argomenti o compilazione di schemi
illimitati. Per il prototipo ammettere un sottoinsieme dichiarato di schemi dei tool revisionati; gli schemi non
supportati rendono il tool non idoneo, non producono un validatore permissivo.

Compilare una volta per definizione revisionata, con limiti di complessità/dimensione e test dei casi annidati.
La validazione non deve eseguire codice scelto dal modello o fidarsi di un «valid: true» ricevuto dal guest.
La scelta e il costo del validatore fanno parte del primo punto di verifica, prima dell'integrazione estesa.

### Allowlist di lettura

Partire da fixture controllate; successivamente da un piccolo insieme di tool GitHub/GitLab già ammessi dai profili
attuali. Per esempio, verificare `search_pull_requests`, `pull_request_read`, `get_project`, `list_pipelines`.
Un tool multipurpose richiede anche una lista di azioni/argomenti consentiti. Nomi, annotazioni o conferma utente
non bastano a inserire un tool non revisionato nel prototipo.

Il profilo GitHub readonly attuale non offre un generico `getRepositories` o tutti i tool del profilo developer:
non inventare quell'API e non cambiare profilo per far funzionare la demo. La prima prova reale può usare un elenco
di repository/progetti fornito dall'utente. Matching fra servizi tramite mappa esplicita o namespace completo:
mai associare due progetti soltanto perché condividono il nome breve.

## 8. Runtime, risorse e gestione degli errori

Valori iniziali fissi nella configurazione interna del prototipo. Nessuna griglia di slider utente nella prima UI.
Modificarli richiede nuova misura e aggiornamento della documentazione.

| Risorsa | Limite iniziale | Applicazione |
|---|---|---|
| Codice JavaScript | 32 KiB UTF-8 | Prima di creare il Worker |
| Runtime QuickJS | 64 MiB heap, stack 512 KiB | API runtime; misura separata della memoria totale |
| Heap JS Worker | 128 MiB | `resourceLimits`, come difesa aggiuntiva, non limite a tutta la memoria WASM |
| Calcolo guest | 5 s cumulativi di esecuzione attiva | Interrupt handler e misure tra gli ingressi nel guest; esclude attese esterne |
| Durata attiva di un job | 120 s, incluse attese MCP | Watchdog dell'host, esclude solo attese approvazione |
| Durata assoluta di un job | 5 minuti, approvazioni incluse | Watchdog dell'host indipendente dal Worker |
| Durata di una richiesta MCP | Minimo tra timeout server e budget residuo del job | Anche in presenza di progress notification |
| Chiamate MCP | 64 tentate per job; 128 per run | Contatore host, incrementato all'accettazione prima di coda/approvazione |
| Esecuzioni di codice | Massimo 3 per run | Include codice errato e tentativi di correzione; non azzera il budget MCP |
| Discovery | Massimo 8 richieste per run, 8 tool per describe | Output di describe al massimo 24 KiB e sempre compatibile col budget del runner |
| Concorrenza MCP | 4 globali per job, massimo 2 per server | Scheduler host; inizialmente massimo un job attivo per finestra |
| Coda MCP | 16 richieste in attesa, approvazioni incluse | Rifiuto esplicito prima di crescita illimitata |
| Argomenti RPC | 64 KiB per richiesta | Controllo host, prima del dispatch |
| Risposta MCP verso guest | 2 MiB per risposta, 20 MiB cumulativi per job | Rifiuto esplicito, non troncamento di array/JSON |
| Risultato verso modello | Massimo 16 KiB, e comunque entro il budget effettivo del runner | Envelope completo JSON valido; dati troppo grandi producono errore breve |
| Traccia/log | Massimo 128 righe di chiamate per run; metadati limitati | Nessun payload o dataset intermedio nei log |

Un programma che accoda più di 16 richieste tutte insieme riceve un errore: gli esempi insegnano batch piccoli
con `Promise.allSettled`, non `Promise.all` illimitata su migliaia di elementi. Per dieci repository il budget di
64 chiamate consente lo scenario di circa 30–31 richieste, lasciando spazio alla paginazione limitata.
Il massimo di 120 s non garantisce che qualunque task su dieci repository termini: i limiti restano visibili.

Con più approvazioni in attesa, il conteggio del tempo attivo viene sospeso solo se non c'è calcolo o chiamata MCP
già in volo: non si può eludere il timeout lasciando una richiesta di approvazione pendente in parallelo ad altro
lavoro. La scadenza assoluta resta sempre applicata. Il limite CPU è una misura operativa approssimata del guest,
non una garanzia di CPU del processo; il watchdog host termina anche una coda infinita di microtask.

Stati distinti: `success`, `partial`, `error`, `denied`, `cancelled`, con codici come `INVALID_CODE`,
`TOOL_NOT_IN_MANIFEST`, `STALE_MANIFEST`, `INVALID_ARGUMENTS`, `MCP_ERROR`, `LIMIT_EXCEEDED`, `TIMEOUT`.
Non dichiarare successo se esistono pagine non lette o richieste dall'esito sconosciuto. I risultati parziali
contengono soltanto valori già restituiti esplicitamente dal programma; niente recupero dei suoi globali dopo timeout.
La traccia delle chiamate completate rimane disponibile anche quando il valore finale è perso.

Stop, negazione o timeout impediscono nuovi dispatch, cancellano coda e approvazioni, propagano AbortSignal,
terminano il Worker e ignorano risposte tardive. Una nuova esecuzione crea un runtime nuovo. Le cancellazioni MCP
sono best effort; una richiesta remota può completarsi comunque. Niente retry automatici nel bridge.

### Limiti reali da dichiarare

- Il limite di risposta verso il guest viene applicato dopo che lo SDK ha ricevuto il risultato MCP. Non garantisce
  un tetto al traffico di rete o alle allocazioni dello SDK durante la ricezione. Usare server fidati, paginazione
  e dataset limitati; verificare eventuali limiti di trasporto disponibili senza promettere un limite inesistente.
- Heap QuickJS, heap V8, WASM, copie JSON e memoria del client MCP sono componenti diversi. Misurare RSS e memoria
  del Worker su carichi limite; non pubblicizzare «64 MiB totali».
- Un tool di lettura può comunque inviare query/dati a un server. Questa versione non è un sistema DLP né un
  controllo completo del flusso di informazioni fra servizi.
- La prompt injection resta possibile al livello del modello. I contenuti esterni non possono modificare manifest,
  policy o approvazioni, ma non si promette che il modello non ne venga influenzato.

## 9. Dipendenze e packaging

- Punto di partenza verificato: `quickjs-emscripten` 0.32.0, API per Promise, memoria, stack e interruzione disponibili.
- Preferire una sola variante release sincrona con Promise guest, non Asyncify e non le varianti debug nel VSIX.
  Valutare `quickjs-emscripten-core` e variante esplicita; la selezione definitiva deve risultare nel lockfile.
- Valutare una sola dipendenza aggiuntiva per JSON Schema se lo SDK non basta; documentare scelta e licenza.
- Nessun esbuild/esbuild-wasm/TypeScript aggiunto al runtime. Esbuild resta il bundler di sviluppo.
- Caricare QuickJS soltanto alla prima esecuzione richiesta; nessun Worker o WASM inizializzato all'attivazione.
- Includere `dist/codeModeWorker.js` e il WASM locale con percorso deterministico relativo all'estensione.
  Nessun CDN o fallback al download sul computer dell'utente.
- Aggiornare `.vscodeignore`, verifica VSIX e notices, comprese licenze effettive del WASM e componenti incorporati.
- Primo budget da verificare: incremento VSIX compresso entro 2 MiB; costo di avvio del job senza MCP entro 500 ms
  di mediana e 1 s p95 sulle macchine dichiarate. Se non passa, misurare la causa prima di introdurre un pool.

La verifica nel VSIX installato è anticipata: non investire nell'intero bridge se il runtime non è distribuibile
con `vsce package --no-dependencies`, il minimo VS Code supportato e gli OS previsti.

## 10. Organizzazione dei moduli

Struttura indicativa, adattabile senza creare un file per ogni concetto:

```text
src/core/tools/executor.ts              # dispatch autorizzato condiviso
src/core/codeMode/contracts.ts          # risultati, RPC, limiti ed errori
src/core/codeMode/discovery.ts          # vista registry, ricerca e manifest
src/core/codeMode/execution.ts          # orchestrazione, budget e chiamate figlie
src/extension/adapters/QuickJSExecutor.ts # Worker, watchdog, ciclo RPC
src/extension/adapters/codeModeWorker.ts # QuickJS, Promise e serializzazione guest
```

Una port di sandbox in `src/core/ports.ts` collega core e adattatore. I metadati di esecuzione attraversano
`events.ts`, protocollo condiviso e transcript senza introdurre una seconda comunicazione webview/host.
Il dettaglio del nome/file può cambiare; le autorità su connessioni e permessi restano uniche.

## 11. Fasi implementative e punti di verifica

Ogni fase produce una modifica revisionabile e un'evidenza. Non attivare la feature per l'utente a metà del percorso.

### Fase 0 — Baseline e contratti

- Fotografare commit, test esistenti, VSIX e richieste generate dal percorso `auto`.
- Definire i task, fixture e risultati attesi della matrice prima di implementare Code Mode.
- Verificare i tool reali dei profili correnti, gli schemi, `structuredContent` e i limiti del validatore scelto.
- Definire envelope, manifest, stati, contatori e criterio di completezza dei risultati.

**Uscita:** baseline riproducibile, dipendenze selezionate e contratto approvabile nel diff. Nessuna percentuale
di risparmio dichiarata come già ottenuta.

### Fase 1 — Runtime isolato e VSIX minimo

- Integrare una sola variante QuickJS in Worker, inizializzazione lazy e caricamento WASM locale.
- Esporre un finto `tools.call` asincrono senza collegamento MCP.
- Verificare return, Promise, `await`, batch, errori, memoria, stack, loop infinito e microtask infiniti.
- Implementare watchdog esterno, Stop, cleanup degli handle e smaltimento delle risposte tardive.
- Costruire e installare il VSIX in profilo pulito; eseguire il Worker da lì, anche senza rete.

**Uscita:** prove reali di isolamento operativo, limiti e packaging. Se fallisce, fermarsi prima del refactor esteso.

### Fase 2 — Esecutore autorizzato condiviso

- Estrarre il dispatch da `AgentRunner.executeCall` preservando i risultati e gli eventi standard.
- Mantenere carico/on-demand/offered nel runner e le decisioni in `permissions/policy.ts`.
- Definire le due provenienze della capacità: richiesta standard e manifest Code Mode.
- Testare cambi di policy, trust e definizioni prima/dopo prepare, approvazione e attesa in coda.

**Uscita:** percorso standard coperto da regressioni; nessun accesso nuovo diretto a `hub.callTool` dal bridge.

### Fase 3 — Dati strutturati e bridge limitato

- Separare risposta MCP e rendering; preservare structured content, testo e stato di errore.
- Introdurre il validatore sugli schemi originali per i tool del prototipo.
- Implementare allowlist, protocollo RPC validato, contatori host, concorrenza e coda limitata.
- Collegare fixture con almeno due server; approvazioni serializzate, revoca, Stop e risultati parziali.

**Uscita:** il programma aggrega dati veri delle fixture e ogni chiamata attraversa gli stessi controlli di Sovran.

### Fase 4 — Discovery e integrazione nell'agent loop

- Aggiungere `code_search`, `code_describe`, `execute_code` con manifest limitati alla richiesta/run.
- Implementare vista di offerta alternativa senza mutare lo stato di caricamento standard della chat.
- Integrare setting utente, comando `/code`, limiti cumulativi per run e provider native/prompted.
- Verificare richieste serializzate: gli schemi MCP completi non devono ricomparire in `tools` o system prompt.

**Uscita:** conversazione completa con modello finto deterministico, discovery precedente al codice, risultato finale
nel normale tool calling e ritorno al comportamento standard nel run successivo.

### Fase 5 — UI e osservabilità minima

- Aggiungere riga espandibile, codice, chiamate figlie, stato e contatori alla UI esistente.
- Conservare la UI di approvazione con gli argomenti; niente approvazioni generiche del programma.
- Esportare un riepilogo benchmark locale con modello, limiti, tempi, byte, inferenze e usage se disponibile.
- Applicare redazione dei segreti conosciuti, limiti di traccia e mancata persistenza dei dataset intermedi.

**Uscita:** l'utente comprende cosa è stato eseguito, cosa è fallito e cosa è stato fermato, anche dopo riapertura chat.

### Fase 6 — Valutazione, compatibilità e decisione

- Eseguire matrice automatica, test di regressione, build e package.
- Prove end-to-end con i due modelli target, confronto appaiato con `auto` e caso reale GitHub/GitLab.
- Verificare VSIX installato su Linux, Windows, macOS Intel e Apple Silicon e sul minimo VS Code supportato.
  Le architetture non provate restano esplicitamente non verificate, senza dedurre copertura dal solo WASM.
- Documentare risultati, limiti, differenze dal piano e decisione di continuare/fermare.

**Uscita:** rapporto con numeri riproducibili e tutti i gate classificati pass/fail/non verificato.

Ordine di grandezza per un ingegnere con supporto AI: circa 10–18 giornate di lavoro per il percorso completo del
prototipo, con la maggiore variabilità in refactor dei permessi, contratti dei server reali e QA multipiattaforma.
È una stima di pianificazione, non una scadenza. Limitare la prima esplorazione runtime/packaging a 1–2 giornate:
se emergono incompatibilità strutturali, riportarle prima di ampliare il lavoro.

## 12. Matrice di verifica

### Test automatici necessari

- **Runtime:** calcolo semplice, return JSON, Promise risolte/rifiutate, async RPC, `Promise.allSettled`, context nuovo
  ad ogni job, disposal anche dopo errore, Worker crash e recupero.
- **Isolamento:** accessi a process/env/require/import/fetch/filesystem/VS Code falliscono anche con accessi indiretti;
  niente oggetti o funzioni host ottenibili dal guest. Non usare soltanto blacklist di stringhe come prova.
- **Risorse:** loop e ricorsione infiniti, catena infinita di Promise, memoria, serializzazione ciclica, BigInt,
  input/output enormi, queue flood, 65a chiamata, manifest grandi e budget condiviso fra esecuzioni.
- **Permessi:** Off/Ask/Allow; gruppi esclusi; untrusted/Plan; tool non revisionato o non descritto; revoca durante
  approvazione/coda; reconnect e schema sostituito; ID RPC riusati; messaggi di un vecchio job ignorati.
- **Dati:** structured content insieme al testo, JSON solo testuale, testo non JSON, schema mancante/non supportato,
  `isError`, contenuti multimediali, output oltre soglia e risultato finale sempre JSON valido.
- **Errori:** nessun conteggio zero al posto di un errore; pagine mancanti segnalate; fallimento di una Promise con
  altre chiamate in volo; cancellazione senza nuove richieste o risposte tardive consegnate al job successivo.
- **Contesto:** non inviare tutti gli schemi, non reinserire traccia/payload nella compattazione, mantenere stabile
  il prompt entro lo stesso insieme di tool, assenza dei tool Code Mode quando il setting è spento.
- **Regressioni:** tool diretti e caricamento auto/all, provider native/prompted, approvazioni, Stop e riapertura chat.
- **Distributabile:** asset nel VSIX, nessun CDN/download runtime, assenza di varianti superflue e notices complete.

Riutilizzare `tests/fixtures/mcp.ts`, i test runner/tool loading/approvals/MCP e gli smoke di estensione. I nuovi test
di isolamento devono eseguire QuickJS reale; un mock del sandbox verifica solo il collegamento, non il runtime.

### Benchmark con modello reale

Sei famiglie, due varianti di dati ciascuna: **12 task per modello**, tre ripetizioni per task e percorso.

| Famiglia | Esempio | Cosa deve verificare il risultato |
|---|---|---|
| Conteggi | PR aperte per repository | Conteggi e filtri esatti |
| Paginazione | Tutte le issue corrispondenti a un filtro | Nessuna pagina ignorata o duplicata |
| Confronto servizi | PR GitHub e pipeline GitLab per mappa di progetti | Associazioni corrette, progetti mancanti espliciti |
| Riduzione dati | Molti record, solo ID/stato richiesti | Stesso esito, payload verso modello molto più piccolo |
| Guasto parziale | Un server fallisce fra risultati validi | Incompletezza dichiarata, niente false conclusioni |
| Controllo semplice | Una richiesta che necessita un solo tool | Costo aggiuntivo visibile, nessun presunto beneficio universale |

Usare fixture con 2 server per semantica/dati e un caso con 10 server × 10 tool per discovery e dimensione del prompt.
I cento tool mock verificano la scala dell'indice; non provano da soli che un modello sappia scegliere ed eseguire.
I task con una sola chiamata si riportano separatamente dagli obiettivi di risparmio per aggregazione.

Due percorsi con task, modello, temperatura, limiti, dati e policy identici:

- A: Sovran standard con caricamento `auto`.
- B: Sovran con `/code`, incluse discovery e generazione del codice.

Alternare l'ordine, separare run a freddo/caldo e usare chat nuove per il confronto principale. Aggiungere un caso
con chat già avviata per controllare cache e ripristino delle unità. Il baseline `all` è solo un riferimento opzionale.
Per isolare il runtime, eseguire prima codice di riferimento scritto a mano sugli stessi dati; questi numeri non
devono essere mescolati ai risultati ottenuti dal modello.

Modelli: uno locale della classe realmente usata dal prodotto, con finestra indicativamente 32k, e uno dietro
gateway OpenAI-compatible. Specificare nome/versione/quantizzazione, hardware e parametri. Se non disponibili,
segnare la validazione prodotto come non eseguita: gli script del provider finto non la sostituiscono.

Misurare una serie prestazionale con tool di lettura già su Allow nelle fixture e una serie di usabilità con Ask.
Non cambiare automaticamente i grant dell'utente per migliorare i numeri. Token, tempo, chiamate MCP, numero di
conferme, correzioni del codice e percentuale di task riusciti sono colonne separate.

## 13. Criteri per considerare concluso il prototipo

- [ ] Feature disattivata per default; richiesta ordinaria invariata e attivazione solo esplicita.
- [ ] SDK/connessioni MCP esistenti riutilizzati, nessun nuovo backend o runtime manuale.
- [ ] JavaScript reale eseguito da QuickJS/WASM, Worker e asset caricati dal VSIX installato.
- [ ] Manifest legati alle definizioni note al modello e controllo live per ogni chiamata.
- [ ] Nessun tool di scrittura/nativo/arbitrario eseguibile dal sandbox e nessun bypass di approvazioni.
- [ ] Dati strutturati preservati, errori/completo/parziale distinguibili e budget rispettati.
- [ ] Traccia comprensibile, Stop efficace sul dispatch locale, cancellazione remota descritta come best effort.
- [ ] Test di sicurezza e regressione passano; compatibilità OS/versioni provata o marcata non verificata.
- [ ] Benchmark contro `auto` eseguito e rapporto con soglie di prodotto pass/fail.
- [ ] README/guida e SECURITY aggiornati soltanto con le capacità effettivamente dimostrate.

Il prototipo può essere tecnicamente completato e risultare non conveniente per il prodotto. È un risultato valido:
in quel caso restano il rapporto e le eventuali migliorie indipendenti, senza promuovere automaticamente Code Mode.

## 14. Consegne previste

1. Modifiche separate e revisionabili per runtime, executor, bridge, discovery, UI e valutazione.
2. VSIX di prova con feature spenta, istruzioni `/code` ed esempio su fixture senza account esterni.
3. Report `docs/plans/2026-11-16-code-mode-prototype-status.md` con test effettivi, limiti e scostamenti.
4. Dataset/istruzioni e script riproducibili del benchmark, con risultati locali privi di credenziali e payload privati.
5. Decisione finale: fermare, mantenere esperimento mirato o pianificare beta. TypeScript, scritture e Auto sono
   eventuali decisioni successive, non lavoro implicito di questo prototipo.

## Riferimenti

- [Caricamento su richiesta già implementato](2026-11-13-on-demand-tools-status.md).
- [Sicurezza del prodotto](../../SECURITY.md).
- [QuickJS: Promise, lifecycle e limiti](https://github.com/justjake/quickjs-emscripten).
- [Distribuzione quickjs-emscripten](https://www.npmjs.com/package/quickjs-emscripten).
- [Worker e limiti di memoria Node](https://nodejs.org/api/worker_threads.html).
- [Code execution con MCP](https://www.anthropic.com/research/code-execution-with-mcp).
