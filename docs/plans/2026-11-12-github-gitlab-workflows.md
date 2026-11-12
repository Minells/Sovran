# Flussi Git, GitHub e GitLab in Sovran

Analisi e piano per `codex/github-gitlab-workflows`, creato dal `main` locale al commit `781119e`.

## Stato attuale

- I tool nativi coprono `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`, `git_stage`, `git_unstage` e
  `git_commit`. `git_branches` può mostrare i riferimenti di tracking già presenti nel clone. Il terminale generico
  può eseguire Git e la sua policy richiede già conferma per `git push`. I tool Git tipizzati possono aggiungere
  anteprima di repository e destinazione, validazione degli argomenti e gestione dello stato dopo l’esecuzione.
  [Registrazione dei tool](../../src/core/tools/builtin/index.ts),
  [regole del terminale](../../src/core/permissions/commands.ts)
- Il preset GitHub usa il server ufficiale hosted con PAT. Il profilo predefinito offre cinque tool di lettura. Il
  profilo Collaborazione aggiunge `issue_write`, `add_issue_comment` e **`create_pull_request`**. Il catalogo filtra
  sia gli header inviati a GitHub sia i tool disponibili nel registro di Sovran. Un PAT con più permessi lascia
  applicabili i filtri del profilo. Oggi si può configurare questo profilo da **Settings → Tools → Integrations →
  Browse Catalog → GitHub MCP**, selezionando **Issues and pull requests with optional writes**.
  [Catalogo](../../src/core/mcp/catalog.ts),
  [configurazione del server GitHub](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- `push_files` di GitHub scrive file tramite API sul repository remoto. `git push` trasferisce gli oggetti Git del
  clone e aggiorna i riferimenti remoti. `fetch`, `pull` e `rebase` operano sul clone, sui riferimenti e, secondo
  l’operazione, su index e working tree. Il flusso da supportare è **commit locale → push del branch → PR o MR**.
  [Tool GitHub](https://github.com/github/github-mcp-server#tools), [Git push](https://git-scm.com/docs/git-push),
  [Git pull](https://git-scm.com/docs/git-pull), [Git rebase](https://git-scm.com/docs/git-rebase)
- Sovran ha già trasporti Streamable HTTP e stdio, token per connessione in VS Code Secret Storage e policy
  Off / Ask / Allow. Il trasporto HTTP attuale configura header statici. Un login OAuth MCP richiederebbe un flusso
  dedicato nell’extension host. Le installazioni gestite sono già versionate, ma il lancio stdio gestito è modellato
  sui browser e ricerca Chrome. [Host MCP](../../src/extension/mcpHost.ts),
  [trasporti](../../src/extension/adapters/McpTransports.ts),
  [lancio gestito](../../src/extension/adapters/ManagedMcpPackages.ts)

## Scelta per GitLab

| Opzione                    | Autenticazione e compatibilità                                                                                                                                                                                                                                                                                                                              | Adozione proposta                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitLab MCP ufficiale**   | Streamable HTTP su `<URL istanza>/api/v4/mcp`. GitLab.com, Self-Managed e Dedicated con MCP disponibile e abilitato. Accetta OAuth con scope `mcp` oppure un PAT fine-grained con risorsa MCP e permesso `Execute`. I PAT legacy, anche con scope `api`, ricevono `403 insufficient_scope`. Nomi e copertura dei tool variano con la versione dell’istanza. | Prima scelta per le istanze compatibili. Il percorso PAT fine-grained riusa il trasporto HTTP e Secret Storage. OAuth è un incremento successivo per le organizzazioni che lo richiedono.       |
| **`@zereight/mcp-gitlab`** | Progetto MIT, eseguibile in stdio sull’extension host. Usa `GITLAB_API_URL` e `GITLAB_PERSONAL_ACCESS_TOKEN` per la REST API GitLab. Espone MR, issue, pipeline e altri tool, secondo versione e configurazione.                                                                                                                                            | Alternativa esplicita per istanze senza MCP ufficiale o per utenti con PAT API tradizionale. Pubblicare il preset gestito dopo revisione di versione, dipendenze e controlli sulle credenziali. |

Fonti primarie per [autenticazione e requisiti del server ufficiale](https://docs.gitlab.com/user/model_context_protocol/mcp_server/),
[tool ufficiali e cronologia](https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/),
[progetto open source](https://github.com/zereight/gitlab-mcp), [licenza MIT](https://github.com/zereight/gitlab-mcp/blob/main/LICENSE).

Gli advisory del progetto open source documentano casi di inoltro di credenziali nei redirect e aggiramento dei
controlli tramite GraphQL. Per il preset scegliere una release supportata con le correzioni applicabili, fissare
versione e lockfile, avviare un processo stdio per connessione con URL fisso, filtrare i tool in Sovran ed escludere
`execute_graphql` e il routing dinamico. Riprodurre i casi rilevanti con token fittizi e due host di test prima di
rilasciare il preset. Il trasporto stdio separa il processo, mentre l’accesso del processo dipende dai permessi
dell’extension host. [Advisory upstream](https://github.com/zereight/gitlab-mcp/security/advisories),
[configurazione upstream](https://github.com/zereight/gitlab-mcp/blob/main/docs/configuration/environment-variables.md)

## Piano di implementazione

### 1. Git nel clone del workspace

- Registrare `git_fetch`, `git_push`, `git_pull` e `git_rebase` nel gruppo Git. Riutilizzare risoluzione del repository,
  `ProcessPort.runFile` con argomenti letterali, anteprima, verifica prima dello spawn e coordinamento delle scritture
  native, condividendo il lock per directory Git comune tra worktree. Aggiungere un dettaglio di approvazione con
  repository, branch, remote effettivo, ref interessati e conseguenze attese. Richiedere conferma in Act anche in Auto.
- `git_fetch` usa un remote nominato e configurato, con refspec di tracking verificati. `git_push` pubblica un singolo
  branch verso un singolo branch remoto, con impostazione dell’upstream su richiesta. Verificare gli URL Git effettivi
  dopo `insteadOf` / `pushInsteadOf`, distinguere URL di fetch e `pushurl` e fermarsi davanti a destinazioni multiple o
  protocolli non supportati. Mostrare la destinazione senza credenziali. Rendere esplicito l’effetto su tag, pruning
  e submodule, così la configurazione Git locale può essere verificata rispetto all’anteprima. La prima versione
  pubblica aggiornamenti fast-forward. Un incremento dedicato può aggiungere `--force-with-lease=<ref>:<oid>` con
  SHA remoto esplicito mostrato nell’approvazione e rifiuto se il valore sul server è cambiato.
- `git_pull` usa il tracking configurato e una strategia esplicita `--ff-only`. In caso di divergenza l’utente può
  scegliere `git_rebase` su una base già presente nel clone. Per pull e avvio del rebase richiedere working tree e index
  puliti, includendo i buffer conosciuti da VS Code, e uno stato Git compatibile. Prevedere `continue` e `abort` per
  il rebase in corso, con anteprime dedicate. Dopo conflitto, timeout o cancellazione, rileggere lo stato e mostrare
  l’azione applicabile prima di tentare altro. Una push interrotta può essere già arrivata al server.
- Git usa SSH o il credential helper HTTPS configurato sull’extension host. Il PAT MCP serve alla connessione API.
  Guidare la configurazione Git in caso di credenziali mancanti. Un eventuale collegamento del PAT a Git HTTPS richiede
  un’azione esplicita del proprietario e verifica di destinazione, percorso e credenziale tramite un helper del sistema.
  [Credenziali Git](https://git-scm.com/docs/gitcredentials), [Git fetch](https://git-scm.com/docs/git-fetch),
  [Git push](https://git-scm.com/docs/git-push)

### 2. GitHub nel catalogo

- Rendere visibile `create_pull_request` nel profilo Collaborazione e spiegare quando il branch deve essere già
  pubblicato. Aggiungere un profilo avanzato ad attivazione esplicita per PR draft, aggiornamento, review, commenti,
  stato Actions e merge. Estendere i toolset per repository, issue, Actions e release per capacità selezionate.
  Per l’accesso al resto del catalogo upstream mantenere il percorso MCP personalizzato già presente. Mostrare i tool
  effettivamente scoperti e i permessi per operazione, ad esempio `Pull requests: write` per creare una PR con un PAT
  fine-grained.
- Usare allowlist locali al momento di discovery e dispatch. Dare conferma puntuale a merge, pubblicazione di release
  e altre nuove azioni ad alto impatto, rispettando Off e il flusso di approvazione esistente. Se il tool di merge lo
  supporta, passare lo SHA della testa appena verificato. Testare il caricamento dei profili `hosted-v1` esistenti,
  comprese regole utente e token. [Server GitHub ufficiale](https://github.com/github/github-mcp-server),
  [permessi REST per le pull request](https://docs.github.com/en/rest/pulls/pulls)

### 3. GitLab nel catalogo e associazione al remote

- Aggiungere la scheda GitLab con nome della connessione, URL dell’istanza e PAT tramite input protetto. L’URL
  supporta porte e sottopercorsi aziendali. Normalizzare mantenendo il prefisso e derivare gli endpoint `/api/v4/mcp`
  e `/api/v4`; validare HTTPS, host e assenza di credenziali, query o frammenti. Usare proxy e CA dell’extension host
  con verifica TLS. Ogni istanza ha un ID e un segreto propri. Cambio di destinazione, riavvio e rimozione invalidano
  la connessione precedente. Un errore sul backend ufficiale può suggerire l’opzione stdio come scelta esplicita.
  [GitLab con URL relativo](https://docs.gitlab.com/install/relative_url/),
  [diagnostica MCP GitLab](https://docs.gitlab.com/user/model_context_protocol/mcp_server_troubleshooting/)
- Per lo stdio open source, riusare l’installer gestito con manifest e lockfile dedicati, separando il lancio dei
  pacchetti che richiedono Chrome. Installare su richiesta con `npm ci --ignore-scripts`, usare l’entry point
  verificato e adattare `verify-vsix.mjs` per includere solo i manifest previsti. Iniettare il PAT nell’ambiente del
  processo dopo aver verificato configurazione, fiducia del workspace e versione. Aggiungere test per tool e
  argomenti ammessi, compresi i nomi alternativi che il server ufficiale pubblica su versioni diverse.
- Offrire lettura di progetti, MR, issue e pipeline e una modalità Collaborazione per creazione, review e merge.
  Distinguere PAT MCP fine-grained, PAT API in lettura (`read_api`) e scrittura (`api`) per il backend REST, e scope
  di Git-over-HTTPS. Mostrare errori azionabili per token assente, scaduto, senza scope o bloccato dalle policy
  dell’istanza. [Scope GitLab](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- Derivare un suggerimento di progetto dal remote selezionato, gestendo HTTPS, SSH, gruppi annidati e fork. Se il remote
  di push e quello di destinazione della PR/MR differiscono, mostrare entrambi con branch sorgente e destinazione e
  chiedere una selezione in caso di ambiguità. Usare il branch predefinito del progetto quando l’utente sceglie di
  applicarlo. Per una creazione con esito incerto, cercare prima una PR/MR aperta per la stessa coppia di branch.

## Criteri di verifica

- **Git reale in fixture isolate.** Due cloni e un bare remoto per pubblicazione, impostazione tracking, fast-forward,
  rifiuto non-fast-forward, fetch e divergenza, conflitto rebase, continue/abort, cancellazione e timeout. Coprire
  cambio di remote/ref dopo approvazione, `pushurl` diverso, riscritture URL, worktree concorrenti, buffer non salvati,
  hook e configurazioni con effetti inattesi, autenticazione mancante, esposizione dei segreti e rifiuto in
  Plan/Restricted Mode.
- **MCP HTTP e stdio con fixture.** Provare discovery, filtri lato host, revoca mentre una chiamata attende conferma,
  revoca di trust, separazione delle credenziali fra istanze, URL custom con porta/prefisso, redirect, errori 401/403
  e messaggi redatti. Esercitare i percorsi esistenti per GitHub, browser, Context7, custom MCP e impostazioni già salvate.
- **Verifica dell’estensione.** Eseguire `npm run check`, build, packaging e controllo del VSIX, smoke test VS Code
  corrente e minimo sui tre sistemi della CI, più una prova su extension host Remote. Usare repository di test con
  credenziali dedicate per fare `commit → push → PR` su GitHub e `commit → push → MR` su GitLab.com e Self-Managed.
  Provare sia un’istanza con MCP ufficiale sia un’istanza accessibile tramite PAT API e stdio. Verificare che il
  risultato mostri il link all’oggetto creato e che la protezione dei branch sia rispettata.

## Baseline verificata

Sul branch appena creato, macOS arm64 con Node 26.13.0 e Git 2.50.1, typecheck, lint e build di produzione sono
passati. La suite completa ha riportato **668 test passati, 2 test browser gestiti opt-in saltati** con accesso al
loopback. Nel sandbox il bind su `127.0.0.1` restituiva `EPERM`, quindi la suite è stata ripetuta con accesso al
loopback. Le prove con PAT reali e la matrice VS Code/Remote riguardano la futura implementazione. Questa baseline
verifica lo stato di `main` al momento del piano.
