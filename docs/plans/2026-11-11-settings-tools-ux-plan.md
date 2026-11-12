# Sovran Settings e Tools

Piano di implementazione basato su `Sovran/main` al commit `3a0afd1`. Le etichette proposte seguono l’inglese già usato nell’estensione.

## Diagnosi

- **La pagina mescola tre ambiti.** `Settings.tsx` monta uno dopo l’altro i gruppi della chat, i permessi dei tool integrati, due editor per nome e l’area MCP. Chi vuole escludere Git dalla chat deve distinguere questa scelta dalla disabilitazione di `git_status` per tutte le chat e dalle policy di un eventuale server GitHub.
- **Le sezioni già richiudibili riducono solo una parte dell’ingombro.** I singoli gruppi integrati e le liste dei tool MCP si possono chiudere. La pagina continua a mostrare tutti i gruppi della chat, le schede dei server e il catalogo completo. Ogni tool integrato, una volta aperto il gruppo, ripete il nome tecnico nei due controlli.
- **Le stime hanno perimetri diversi.** `SovranController.toolsView()` proietta disponibilità e stima per gruppo in base a modalità, modello e restrizioni. `McpHost.serverView()` stima le definizioni consentite dalla policy del server, indipendentemente dalla selezione nella chat. Mostrare entrambe come costo per richiesta può far apparire disponibili tool MCP esclusi, per esempio in Plan.
- **La policy salvata e la disponibilità sono due informazioni distinte.** Un tool può essere abilitato per tutte le chat e risultare indisponibile nella chat corrente. Un server può essere configurato e disconnesso mentre il suo gruppo risulta selezionato. Queste combinazioni sono valide e vanno rappresentate senza dedurre lo stato di un controllo dall’altro.

Nell’anteprima della webview a 320 px, con tema scuro e dati simulati, i gruppi della chat e gli override integrati spingono l’inizio della prima scheda MCP quasi al fondo di una finestra alta 880 px. Anche senza server, il catalogo comincia vicino al fondo. La proposta porta lo stato delle integrazioni in alto, insieme agli altri due riepiloghi.

## Vista proposta

Al primo accesso, tre righe espandibili riassumono la configurazione. L’esempio mostra una chat con un gruppo escluso e un’integrazione che richiede attenzione.

```text
Settings                                      All settings
Models   Approvals   Agent   [Tools]   Context   Data

› Tools for this chat              11 available in Act
  1 group excluded

› Built-in tools                   2 overrides
  Applies to all chats in this VS Code profile

› Integrations                     1 connected
  1 needs attention
```

Le tre righe usano divisori, testo allineato a sinistra e i font, i colori e il focus del tema VS Code. Nelle sidebar strette lo stato va a capo sotto il titolo. Il nome tecnico del tool resta in monospace nella vista di dettaglio. Lo stato è leggibile anche senza colore.

### Tools for this chat

- La riga chiusa mostra il totale dei tool disponibili **nei gruppi selezionati** e le esclusioni, se presenti. La modalità può essere indicata nel riepilogo. Quando il modello non offre tool o nessun gruppo selezionato ne offre, la riga esplicita il motivo quando noto. Uno stato mancante o in attesa resta distinto da un conteggio pari a zero.
- Aprendo la riga compaiono i gruppi esistenti, con nome, disponibilità e selezione. Per i gruppi non selezionati la disponibilità indica cosa si potrebbe usare selezionandoli nel contesto corrente. Un’integrazione configurata e disconnessa resta selezionabile, con stato esplicito. I gruppi integrati e quelli delle integrazioni possono usare due semplici etichette all’interno della stessa lista.
- Il dettaglio mostra una sola stima totale delle definizioni e, dove il dato aiuta a decidere, la stima per gruppo. Usare `definitionTokens` dalla proiezione del controller e chiamarla **Estimated definition tokens**. Il valore riguarda le definizioni disponibili, dipende dalla modalità e non rappresenta i token fatturati. Il dettaglio spiega anche che escludere un gruppo blocca le chiamate in attesa.
- Il menu **Tools** accanto al composer mantiene lo stesso elenco e lo stesso stato. È la scorciatoia per regolare la chat senza passare da Settings. Il riepilogo e l’elenco leggono lo snapshot dell’host e inviano `setToolGroup` con l’ID della chat. Se si apre un’altra chat, conteggi e selezioni seguono quella chat.

### Built-in tools

- La riga chiusa indica **Default permissions** con le liste vuote, oppure il numero di nomi distinti presenti nelle due liste. Un tool disabilitato e soggetto a conferma conta una volta. I nomi validi salvati manualmente restano conteggiati e accessibili anche quando la versione corrente non registra quel tool.
- All’apertura compaiono i gruppi già esistenti, con un’indicazione delle personalizzazioni dove presenti. Nei gruppi aperti, ogni tool ha una sola riga con nome, descrizione breve, `Enabled` e `Always ask`. La descrizione completa e il rischio restano consultabili nel dettaglio. Il testo di aiuto di `Always ask` chiarisce che vale anche per le letture e in Auto. Lo stato **Unavailable in this chat**, quando pertinente, compare separato dalla policy e conserva il motivo restituito dall’host.
- Conservare i due controlli indipendenti. Se entrambe le preferenze sono impostate, il tool resta disabilitato e la richiesta di conferma torna a valere quando viene riabilitato. La scelta a tre stati usata da MCP eliminerebbe questa combinazione. Tenere **Advanced native overrides** in fondo alla sezione come punto di accesso agli editor per nome, comprese le voci non riconosciute dalla versione corrente.

### Integrations

- La riga chiusa mostra `None configured`, il numero di connessioni o uno stato come `Restricted Mode`. Evidenziare con testo gli errori di connessione, i token richiesti per server attivi e i problemi di installazione. Una configurazione volontariamente disconnessa ha uno stato distinto. Il testo del problema e l’azione di recupero devono essere visibili nella riga del server appena si apre **Integrations**.
- Nell’elenco, nome, stato e prossima azione utile occupano il primo livello. I dettagli del server contengono comando o URL, host, versione, profilo, gestione del token, impostazioni, rimozione e policy `Off / Ask / Allow`. Mantenere il comportamento esistente di switch e azioni per i server personalizzati. Conservare il recupero contestuale (`Set token`, `Try again`, `Show logs`) e l’avviso quando un token è inviato via HTTP.
- **Add integration** apre il catalogo. **Add custom server** apre il form esistente con l’import JSON. Per una voce di catalogo usare **Add to Sovran** nel passaggio di setup, seguito dalle azioni `Install dependencies` e `Connect` dove previste. Selezione del profilo, compatibilità Remote, stato disconnected dopo l’aggiunta e conferma di connessione seguono il flusso dell’host. Le informazioni su credenziali, tab del browser e accesso agli account rimangono accanto all’azione pertinente.
- Togliere il totale aggregato dei token dall’area MCP. Se si conserva la stima nel dettaglio del singolo server, chiamarla **Estimated definition size** e spiegare che descrive i tool abilitati sul server. Il totale per la chat resta nella prima sezione.

## Altre impostazioni

Applicare lo stesso criterio in un intervento successivo, riusando il controllo espandibile dopo averlo verificato in Tools.

| Area | Visibile | Da aprire |
| --- | --- | --- |
| Models | Act model e gestione provider. Stato del provider visibile quando serve un intervento. | Plan model, titoli automatici e limiti in **Model options**. Gestione di `config.yaml` in **Configuration file**, con stato di sincronizzazione o errore in sintesi. |
| Approvals | Modalità della finestra, spiegazione di Plan e avvisi su Auto o Restricted Mode. | Modalità iniziale, comandi consentiti e file protetti. Se si usa Auto all’avvio, evidenziarlo anche a sezione chiusa. |
| Agent | Preferenze sull’apertura del diff e sulla visibilità del terminale. | Numero massimo di passi e timeout in **Execution limits**, con indicazione degli override del workspace. |
| Context | Opzioni che decidono cosa entra nel contesto, come file attivo e istruzioni di progetto. | Compattazione e dimensione dei risultati in **Context limits**, con eventuali override del workspace. |
| Data | Persistenza, informazioni sul trattamento dei dati, log e accesso alle chiavi. | La pagina è già breve. |

## Implementazione

1. **Struttura di Tools.** Estrarre il contenuto Tools da `Settings.tsx` in un pannello dedicato e riusare `ChatToolGroups` fra composer e Settings. Usare pulsanti con stato espanso accessibile e focus visibile. Caricare i controlli alla prima apertura e tenerli montati durante la visita del tab, così una bozza non si perde richiudendo la sezione. Al primo montaggio i riepiloghi leggono lo stato e non inviano scritture. Conservare le sei schede, `settingsArea: 'mcp'`, la navigazione da tastiera e **All settings**.
2. **Righe dei tool integrati.** Riordinare `NativeToolSettings` e riusare i `ListEditor` per gli override. La disponibilità è una spiegazione, mentre i checkbox leggono `disabledTools` e `forceAskTools`. Attenzione alle modifiche ravvicinate nella stessa lista. Oggi ogni azione ricostruisce l’intero array dallo snapshot della webview e lo invia via `updateSetting`, quindi due modifiche prima del patch possono sovrascriversi. Coprire la sequenza con uno scenario di test. Se serve correggerla, farlo in una modifica separata e usare operazioni per nome serializzate nell’host, lette dal valore utente corrente. Coordinare anche le scritture dall’editor avanzato. Conservare chiavi, validazione, scope e valori già memorizzati.
3. **Scoperta e gestione delle integrazioni.** Riorganizzare `McpArea` e `ServerCard` attorno agli stati esistenti. Riutilizzare `ServerForm`, `ImportSnippet`, `ToolList` e `PolicyChoice`. Conservare i messaggi al controller e i controlli dell’host per trust, conferme e credenziali. Il catalogo e il form si aprono solo su azione esplicita. Dopo chiusura del form il focus torna all’azione di apertura, o a una destinazione vicina se questa è scomparsa. Verificare che aggiornamenti asincroni del server non spostino il focus mentre si modifica un form.
4. **Riepiloghi verificati.** Derivare i conteggi dai dati dell’host. Usare `mcp.servers` per lo stato dei server e `toolGroups` per il totale della chat. Se per distinguere modello mancante, `toolMode: none` e altri casi di zero serve un dato aggiuntivo, proiettarlo come campo opzionale dal controller, riusando `effectiveModel()`. Evitare di ricostruire nella UI il filtro di `ToolRegistry` o la logica di approvazione dell’agente. Il renderer deve gestire snapshot che non hanno i campi opzionali.
5. **Altri tab.** Applicare i raggruppamenti della tabella in una modifica separata. Conservare i commit dei campi numerici su blur o Enter, la validazione degli editor, gli avvisi di override e le azioni esistenti. Aggiornare i percorsi nella guida utente dopo aver stabilizzato le etichette.

I primi quattro passi possono essere revisionati in due PR, una per riepiloghi e permessi integrati e una per MCP. Il riordino degli altri tab può seguire dopo aver verificato Tools. La priorità è cambiare la presentazione senza migrare chat, configurazioni o credenziali. In particolare, `Session.excludedToolGroups` continua a memorizzare le esclusioni, i gruppi dei server mantengono gli ID `mcp:<id>` e le integrazioni già salvate mantengono policy, profili e Secret Storage. L’esecuzione resta soggetta al registry e alla rivalutazione dei permessi dell’host, anche dopo l’approvazione.

## Criteri di accettazione

| Scenario | Risultato atteso |
| --- | --- |
| Prima apertura con default e senza server | Tre riepiloghi leggibili nella sidebar. Catalogo, form, liste e policy dettagliate sono chiusi. L’apertura di Settings o di una sezione non invia comandi di modifica, installazione o connessione. |
| Chat nuove, precedenti e due chat aperte | Le chat senza esclusioni conservano il comportamento predefinito. La modifica dal composer o da Settings riguarda la chat indicata, sopravvive alla riapertura con persistenza abilitata e non si propaga a un’altra chat. |
| Plan, Restricted Mode, tool mode `none` | Il riepilogo coincide con le definizioni disponibili secondo lo stato dell’host. Il passaggio di modalità o modello aggiorna il riepilogo senza modificare le selezioni salvate. |
| Permessi integrati | La UI rende leggibili default, esclusione, conferma e disponibilità corrente. Disabilitare e riabilitare conserva la preferenza `Always ask`. I nomi validi non registrati restano editabili. Due modifiche ravvicinate alla stessa lista vanno verificate con patch ritardati. |
| Chiamata in attesa | Esclusione del gruppo, disabilitazione del tool e revoca di policy MCP continuano a bloccare la chiamata nei casi già coperti dai test del runtime. |
| MCP | Con server gestiti e personalizzati verificare stato disconnesso, avvio, connessione, token mancante, errore e recupero. Verificare add/import/edit/rimozione, avviso HTTP, policy `Off / Ask / Allow`, e il flusso di installazione e connessione esplicita. Il collegamento al profilo Chrome desktop tramite estensione rimane indisponibile su Remote. |
| Tastiera e layout | Navigazione dei tab e delle sezioni, focus al ritorno da un form, Escape e click esterno nel menu del composer. Verificare sidebar a 320 e 420 px, temi chiaro, scuro e alto contrasto, testo lungo e zoom senza scorrimento orizzontale. |
| Installazione o aggiornamento | Smoke test con profilo VS Code di test e chat, override nativi e server MCP già salvati. Verificare che si leggano dopo reload e che restino utilizzabili. |

Aggiornare le asserzioni di `webview/src/App.test.tsx` per passare dalle nuove aperture e continuare a verificare i messaggi inviati. Riutilizzare `toolGroups.test.ts`, `toolSettings.test.ts`, `toolAvailability.test.ts`, `surfaces.test.ts` e `hostMcp.test.ts` per i contratti del runtime. Prima del merge eseguire `npm run check`, `npm run build` e `npm run test:extension`. Per la verifica visiva usare `npm run dev:webview` con `?scenario=settings&area=mcp`, `mcp=empty` e `mcp=restricted`, poi controllare tastiera, focus e temi nella webview reale. Allineare i dati simulati dei gruppi a quelli dei server e della modalità prima di usare il mock per verificare i conteggi. Nel mock originale il gruppo GitHub era presente anche con `mcp=empty`.

Baseline verificata per questo piano: 102 test della webview e 50 test mirati su gruppi, permessi, sessioni e MCP. I criteri della nuova UI si verificano dopo l’implementazione.
