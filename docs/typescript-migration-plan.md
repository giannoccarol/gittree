# Piano di migrazione completa a TypeScript

> Stato: proposta — richiede decisione di prodotto esplicita (ADR-0008) prima di ogni implementazione.
> AGENTS.md e la skill `gittree-vanilla-architecture` vietano oggi TypeScript senza una decisione
> esplicita: questo documento è la base per quella decisione, non un'autorizzazione a iniziare.

## 1. Perché migrare

- **Contratti IPC tipizzati**: l'inviluppo `{ error }`, i canali IPC e il bridge `window.gitTree`
  sono oggi protetti solo da test runtime (`ipc-parity`, `preload-contract`). I tipi condivisi tra
  main, preload e renderer spostano parte di quella protezione a compile-time.
- **Dominio ricco di stati**: operation state (merge/rebase/cherry-pick), working tree snapshot,
  conflitti, ammissione repository sono unioni di casi che oggi vivono come convenzioni.
- **Refactor sicuri**: la codebase ha già ottime reti di caratterizzazione (~90 file di test);
  i tipi rendono ogni estrazione futura più economica.
- **Onboarding**: i confini descritti in `CONTEXT.md` diventano verificati dal compilatore.

Contro (da valutare nell'ADR): aggiunge un passo di build/transpile (oggi assente), allunga il
feedback loop, introduce una dipendenza dev (`typescript`) e richiede aggiornamento di AGENTS.md,
skill e ADR esistenti.

## 2. Stato attuale (inventario)

| Area | File | LOC | Note |
|---|---|---|---|
| Main process | ~45 | ~9.500 | CommonJS, composizione in `main.js` → `main-application.js` |
| Renderer | ~35 | ~13.000 | Script classici caricati da `index.html`, pattern duale `/* exported */` + `module.exports` (27 file) |
| Preload | 2 | ~600 | `window.gitTree`, contratto testato |
| Test | ~90 | — | `node --test`, c8 con glob `src/**/*.js`, E2E Playwright Electron |

Dipendenze con tipi già pronti: `simple-git`, `i18next`, `@xterm/*`, `electron-updater`,
`electron`. Da tipizzare a mano o con `@types`: `adm-zip`, `node-pty` (ha tipi parziali),
`diff2html` (tipi inclusi ma incompleti).

Vincoli hard da preservare durante tutta la migrazione:

1. Nessun cambio di comportamento pubblico: canali IPC, inviluppi `{ error }`, chiavi storage,
   scorciatoie, formati persistiti.
2. `GitService` e `HostingService` restano facade stabili.
3. Coda Git per-repository e validazione input alla seam IPC invariate.
4. Nessun bundler: il transpilatore unico è `tsc` (decisione raccomandata, vedi §4).
5. Ogni checkpoint passa da `npm run quality`; i contratti passano da `npm run test:contracts`.

## 3. Strategia scelta

**Conversione incrementale file-per-file, leaf-first, con doppio albero JS/TS controllato da gate.**

- Fase 1–4: `allowJs: true`, `checkJs: true`, `noEmit` — TypeScript agisce solo come typechecker
  sull'albero JS esistente. Zero rischio runtime, valore immediato sui domini già annotati in JSDoc.
- Fase 5+: ogni directory convertita ottiene un proprio `tsconfig` con `strict: true` ed emette JS
  compilato; le directory non convertite continuano a girare come oggi.
- Il renderer migra per ultimo perché richiede il cambio di caricamento (script classici → ESM),
  che è l'unico vero cambio strutturale del piano.

Perché non le alternative:

- *Big bang*: 25k LOC e 27 file renderer accoppiati via global — rischio sproporzionato.
- *Solo JSDoc + checkJs per sempre*: nessun beneficio di ergonomia (generics, unioni discriminanti,
  `satisfies`), e il doppio standard resta permanente.
- *esbuild/swc come transpilatore*: più veloci ma violano lo spirito "no bundler" e aggiungono
  due tool dove `tsc` basta alle scale di questo progetto (build < 10s stimabili).

## 4. Decisioni architetturali (da ratificare nell'ADR-0008)

| # | Decisione | Raccomandazione | Alternativa scartata |
|---|---|---|---|
| D1 | Transpilatore | `tsc` unico, no bundler | esbuild/swc |
| D2 | Moduli main/preload | Restano CommonJS emessi da tsc in `dist/` | ESM ovunque (churn su require dinamici e mock di test) |
| D3 | Moduli renderer | ESM nativo (`<script type="module">`), sorgenti `.ts` emessi in `dist/renderer` | Bundle singolo (vieta debug 1:1 e viola "no bundler") |
| D4 | Strictness | `strict: true` alla conversione di ogni file; ratchet globale sugli errori residui JS | strict solo alla fine |
| D5 | Esecuzione test | Test girano sui sorgenti via `--experimental-strip-types` in dev locale, su output `dist/` in CI | tsx/ts-node (dipendenza extra) |
| D6 | Tipi condivisi | `src/shared/` come unico home dei contratti (canali, envelope, bridge, modelli dominio) | `.d.ts` duplicati per processo |

Nota su D5: Node ≥ 22.18 esegue `.ts` con sintassi erasabile senza flag; la CI compila comunque con
`tsc` per determinismo e per coprire sintassi non-erasable. Se il supporto si rivela instabile,
fallback immediato: test sempre su `dist/`.

### Meccaniche di transizione validate (spike M0)

- Electron 43 integra Node 24.18 con type stripping attivo: i `.ts` con sintassi erasabile
  girano nativamente in main process e nei test, senza emit. Verificato empiricamente.
- **Ricetta di conversione main/shared** (validata su git-version):
  - il file convertito diventa `.mts` con `export` reali (tipizzati per tsc, eseguiti come
    ESM dallo stripping);
  - i consumatori CJS non convertiti usano `require('./modulo.mts')` — l'interop
    `require(esm)` di Node ≥ 22.12 restituisce il namespace, la destrutturazione funziona;
  - estensione esplicita obbligatoria: `require('./x')` NON risolve `x.mts`;
  - niente sintassi non-erasable (`enum`, `namespace`, parametri properties);
    `erasableSyntaxOnly: true` lo impone in typecheck.
- Il flip finale (M7) emette `.mjs`/`.js` puliti in `dist/` con
  `rewriteRelativeImportExtensions: true`.
- Le foglie renderer restano `.js` finché M6a non introduce l'ESM: il browser non strip-pa i
  tipi e gli script classici non possono caricare `.ts`.

## 5. Miglioramenti architetturali mirati

La migrazione non è la scusa per rifare tutto: gli interventi sotto sono quelli che pagano due
volte — migliorano la manutenibilità ora e rendono la conversione TS più semplice e i tipi più
onesti. Principio di sequenziamento:

- **Domini da smontare → prima il refactor, poi i tipi** (tipare un god-object significa
  riscrivere ogni firma due volte).
- **Contratti stabili condivisi → prima i tipi, poi eventuali refactor** (sono la base di tutto).

### Catalogo interventi

| # | Intervento | Evidenza oggi | Pattern risultante | Slot |
|---|---|---|---|---|
| A1 | Eliminare il monkey-patching della coda su `GitService.prototype` | `git-service.js:1213-1221`: loop di metaprogramma che avvolge tutti i metodi async | Decorator esplicito per-metodo o wrapping alla costruzione; la coda diventa visibile e tipizzabile | Pre-M3 |
| A2 | Scomporre `app.js` (935 righe, 40+ metodi) | Mescola chrome finestra, scorciatoie, stash, toast, search, resize, inspector, toolbar | `ToastService`, `StashView`, `WindowChromeController`, `ToolbarController` come collaboratori con `mount/update/destroy`; `app.js` resta composition root | Pre-6b |
| A3 | Formalizzare la comunicazione eventi | `app.emit` ad-hoc raggiunto dai componenti (`repo-tabs` fa `app.emit`×5, `app.state`×5); `webContents.send` sparso in 4 file main | EventBus minimale tipato nel renderer; unico `RendererNotificationsPort` nel main che incanala tutte le push verso il renderer | M4–M5 |
| A4 | Componentizzare `settings-view.js` (1328 righe, il file renderer più grande) | Un solo componente per tutte le sezioni settings | Sezioni come sub-componenti con lifecycle esplicito, stato per sezione | 6b |
| A5 | Separare dati e logica in `i18n.js` (1677 righe) | Risorse traduzioni e loader nello stesso file | Modulo risorse (dati puri) + loader piccolo; chiavi tipizzate da schema const; `i18n-parity` resta guard runtime | 6b early |
| A6 | Refresh a evento invece di polling | Timer di sync in `repo-tabs` e altri componenti | Invalidazione guidata dalle notifiche del port A3 | Backlog, post-M8 |
| A7 | Tipizzare l'inviluppo IPC senza cambiarlo | `{ error }` è contratto pubblico protetto da contract test | Unione discriminante lato `src/shared` (`{ ok: false, error }`-like in tipo, forma runtime invariata); **qualsiasi cambio di forma richiede nuovo ADR** | M2 |
| A8 | Layer di modelli di dominio condiviso | I dati viaggiano come oggetti plain costruiti ad-hoc nei service/parser; unica eccezione `conflict-model.js` | `src/shared/models/`: entità pure tipate (`CommitSummary`, `Branch`, `Ref`, `WorktreeSnapshot`, `OperationState`, `PullRequest`, `RepositoryEntry`, `ConflictFile`) ciascuna con normalizzatore `parse(unknown): Model \| ValidationError`; validazione IPC (ADR-0004) e tipi diventano la stessa cosa. Solo tipi + guardie, niente ORM/framework | M2 |

### Cosa NON facciamo (vincoli vanilla confermati)

- Nessun framework DI, nessuna libreria di stato (Redux/Zustand-style), nessun RxJS: injection
  via costruttore e un eventuale EventBus di ~40 righe bastano alla scala del progetto.
- Nessun pattern aggiuntivo dove esiste già quello giusto: facade (`GitService`,
  `HostingService`), adapter/registry (hosting providers, ai providers, agent adapters,
  handler-registry), session/queue per repository, component lifecycle. Sono già i pattern
  corretti: la migrazione li tipizza, non li sostituisce.
- Nessuna interfaccia "decorativa": ogni astrazione nuova deve eliminare duplicazione reale o
  proteggere una seam già testata.

## 6. Roadmap

Stime indicative per 1 maintainer a tempo parziale sul progetto. Ogni milestone è un insieme di
commit piccoli, indipendentemente revertibili, Conventional Commits (`refactor:`, `build:`, `chore:`).

### M0 — Decisione e governance (settimana 1)

- [ ] ADR-0008 "Adozione TypeScript incrementale": motivazioni, decisioni D1–D6, invarianti
      preservate, strategia di rollback per milestone.
- [ ] Aggiornare `AGENTS.md`, `CONTEXT.md` e le skill (`vanilla-architecture`, `test-engineering`,
      `design-system`, `release`) per riflettere la nuova regola: niente nuovo codice JS nelle
      directory convertite.
- [ ] Spike su branch usa-e-getta: `tsc --noEmit --allowJs --checkJs` sull'albero intero, misura
      errori per directory, stima fine della baseline.
- **Gate**: ADR mergiato; spike smaltito; nessun codice in `master`.

### M1 — Fondamenta toolchain (settimane 2–3)

- [ ] DevDependencies: `typescript`, `typescript-eslint` (parser minimo, nessuna regola stilistica).
- [ ] `tsconfig.base.json` (target ES2023, module NodeNext per main / ES2022 per renderer,
      `allowJs`, `checkJs`, `noEmit`) + `tsconfig.typecheck.json`.
- [ ] Script `npm run typecheck`; integrazione in `scripts/quality.js` e nel job CI esistente.
- [ ] Baseline errori: file `tserror-baseline.json` generato dallo spike; gate CI = "gli errori
      non aumentano mai". Strumento piccolo in `scripts/check-ts-baseline.js`.
- [ ] ESLint: progetti typescript-eslint solo sui file toccati dalle conversioni (regole
      type-aware progressive).
- **Gate**: `npm run quality:full` verde con typecheck in ratchet; zero cambi runtime.

### M2 — Contratti condivisi e foglie pure (settimane 3–5)

- [ ] Creare `src/shared/`: tipi per inviluppo `{ error }`, nomi canali IPC (const object +
      `satisfies`), metadati repository, operation state, snapshot working tree.
- [ ] **A8** — `src/shared/models/`: entità di dominio pure tipate con normalizzatore
      `parse(unknown)` ciascuna; i contract test IPC estendono le asserzioni sui modelli
      (ogni payload registrato deve passare il parse del proprio modello).
- [ ] Conversione delle foglie senza I/O né DOM (caratterizzate da test già solidi):
      `diff-parser`, `blame-parser`, `conflict-model`, `graph-layout`, `graph-viewport`,
      `branch-naming`, `workspace-profile-conversion`, `provider-links`, `html-encoder`,
      `localized-date-formatter`, `git-version`.
- [ ] Ogni file: rinomina `.js`→`.ts`, tipi espliciti sui export pubblici, `strict: true` locale,
      import aggiornati nei test (i test restano JS finché M6).
- **Gate**: `npm run test:contracts` e suite dei domini toccati verdi; baseline in calo.

### M3 — Dominio Git main process (settimane 5–8)

Ordine dentro la fase: moduli interni → facade → composizione.

- [ ] **A1** — Refactor pre-conversione: sostituire il monkey-patching di `git-service.js:1213`
      con wrapping esplicito alla costruzione (commit separato + test di caratterizzazione sulla
      semantica della coda: serializzazione, rientranza `AsyncLocalStorage`, identità worktree).
- [ ] `src/main/git/*` (`repository-operations`, `repository-working-tree`, history, parser):
      tipizzare gli stati dell'operazione (merge/rebase/cherry-pick) come unioni discriminanti.
- [ ] `repo-manager`, `repository-scanner`, `repository-workspace`, `working-tree-repository`.
- [ ] `git-service.js` per ultimo: la firma pubblica resta identica (invariante); i tipi
      documentano ciò che i contract test verificano a runtime.
- [ ] `credential-vault`, `logger`, `oauth-config`, `deep-link`, `update-service`.
- **Gate**: coverage scope `git` invariato o migliorato; benchmark `perf:*` entro soglia.

### M4 — Hosting, AI, agenti e seam IPC (settimane 8–10)

- [ ] `hosting/providers/*` con interfaccia provider normalizzata tipizzata; poi `hosting-service`.
- [ ] `ai/*` e `agents/*` (contratti provider OpenAI-compatible/Anthropic/CLI come tipi).
- [ ] `src/main/ipc/*`: ogni handler dichiara il tipo `(input: X) => Promise<Result>` derivato da
      `src/shared/`; la validazione alla seam resta obbligatoria (i tipi non sostituiscono la
      validazione dell'input non fidato — ADR-0004).
- [ ] **A3 (parte main)** — Consolidare i `webContents.send` sparsi (`main-application.js:135`,
      `update-service.js:157`, `inspector-window-controller.js`, `agent-session-service.js`)
      dietro un unico `RendererNotificationsPort` iniettato; canali come tipi const condivisi.
- [ ] Estendere `ipc-parity.test.js` e `preload-contract.test.js` con asserzioni statiche:
      ogni canale registrato deve esistere nel tipo del bridge e viceversa.
- **Gate**: `npm run test:contracts` verde; nessun canale nuovo né rimosso.

### M5 — Preload e bridge (settimana 10–11)

- [ ] `preload.ts`: un'unica interfaccia `GitTreeBridge` in `src/shared/bridge.ts` diventa la
      fonte di verità; `contextBridge.exposeValue`/`exposeFunction` mappata 1:1 sui metodi.
- [ ] `preload-inspector.ts` con la sua interfaccia dedicata.
- [ ] Il renderer consumerà il tipo del bridge anche prima di essere convertito (via JSDoc
      `@type {import('../shared/bridge').GitTreeBridge}`) — valore immediato senza conversione.
- **Gate**: `preload-contract.test.js` esteso e verde; audit hardening invariato.

### M6 — Renderer (settimane 11–15) — fase strutturalmente più rischiosa

Sotto-fase 6a — cambio caricamento (behavior-preserving):

- [ ] **A2** — Scomposizione di `app.js` in collaboratori (`ToastService`, `StashView`,
      `WindowChromeController`, `ToolbarController`), un'estrazione per checkpoint con test di
      caratterizzazione; `app.js` ridotto a composition root puro.
- [ ] **A3 (parte renderer)** — Sostituire `app.emit` e le letture `app.state` dei componenti
      con un EventBus minimale tipato e callback strette (prerequisito dell'ESM: i moduli non
      tollerano l'accoppiamento globale).
- [ ] Convertire l'output renderer in moduli ESM emessi da tsc; `index.html` carica un entry
      module; eliminare progressivamente il pattern `/* exported */`.
- [ ] Completare prima l'iniezione delle dipendenze residue (`window.app`, letture globali)
      secondo la skill vanilla-architecture: i moduli ESM non tollerano l'accoppiamento globale.
- [ ] Playwright E2E e `test:renderer-ui` come rete di sicurezza; confronto `perf:renderer`
      prima/dopo (budget: nessuna regressione > 5% su first paint e apertura repo).

Sotto-fase 6b — conversione componenti, leaf-first:

- [ ] **A5** — Separare risorse e loader in `i18n`, chiavi tipizzate da schema const.

- [ ] Utility: `theme`, `i18n` (tipizzare le risorse con schema chiave→stringa; il test
      `i18n-parity` resta il guard runtime), `html-encoder`, `dialog-service`.
- [ ] Controller: `workspace-state-controller`, `shortcut-controller`,
      `workspace-resize-controller`, `workspace-panel-motion`,
      `remote-operation-controller`, `repository-load-session`,
      `repository-workspace-controller`.
- [ ] Componenti piccoli→grandi: `search`, `gitflow`, `inspector-graph`, `merge-workspace`,
      `welcome`, `repo-tabs`, `branch-context-menu`, `commit-context-menu`, `diff-viewer`,
      `changes-view`, `graph-view`, `branch-list`, `conflict-resolver`, `pull-request-view`,
      `worktree-agent-panel`.
- [ ] **A4** — Componentizzare `settings-view` in sezioni con lifecycle esplicito, convertendo
      ogni sezione appena estratta.
- [ ] Per ultimi: `app.js` (composition root, unico punto ammesso per i global) e
      `inspector-window.js`.
- **Gate**: `npm run audit:design` verde; E2E verde; perf entro budget.

### M7 — Main process composition e packaging (settimane 15–16)

- [ ] `main-application.ts`, `application-runtime.ts`, `main.ts`, controller finestre,
      `diagnostics-exporter`, `inspector-window-controller`.
- [ ] Flippare la build: `prepare:assets` e `electron-builder` puntano a `dist/`;
      `main` in package.json → `dist/main/main.js`; verificare globs `files`, asar, OTA metadata
      e firma (usare la skill gittree-release; provare `npm run dist` per tutte e tre le OS in CI).
- [ ] c8: glob aggiornati a `dist/**/*.js` con source map, oppure `--include src/**/*.ts`;
      ricalibrare `check-coverage-scopes.js` sulle nuove unità.
- **Gate**: `npm run release:check` verde; build di prova installabile e aggiornante (OTA check).

### M8 — Chiusura (settimana 17)

- [ ] Ultimi file JS convertiti; rimuovere `allowJs`/`checkJs` e la baseline degli errori;
      `strict: true` globale.
- [ ] Test suite: decisione consapevole se convertire i test (consigliato: sì, gradualmente,
      dopo il freeze del prodotto; i test possono restare JS validi per tempo indefinito).
- [ ] Rimuovere codice morto emerso dai tipi; passaggio finale `npm run quality:full` +
      `quality:bench` + E2E su tutti i SO.
- [ ] Aggiornamento definitivo di README, ARCHITECTURE.md, CONTRIBUTING e skill.
- **Gate**: nessun file `.js` in `src/` (fuorchè eventuali eccezioni documentate nell'ADR);
      pipeline release completa verde end-to-end.

## 7. Regole during-migration

1. **Nessun refactor nascosto nella conversione**: rinominare `.js`→`.ts` e tipizzare NON cambia
   logica. Ogni diff che cambia logica va in commit separato con test propri.
2. **Refactor architetturale e conversione TS sono milestone/commit separati**: prima l'estrazione
   (comportamento invariato, test verdi), poi la conversione del risultato. Mai nello stesso diff.
3. **Ratchet**: il numero di errori TS può solo scendere; il gate CI lo impedisce.
4. **Nuovo codice**: dalle M2 in poi, ogni file nuovo in una directory convertita nasce `.ts`
   strict; nelle directory non convertite resta JS (per evitare conversioni guidate dal caso).
5. **Un dominio per checkpoint**: mai mescolare conversione TS e feature (già regola AGENTS.md).
6. **Rollback per milestone**: ogni milestone è preceduta da tag; il flip del packaging (M7) è
   l'unico punto non banalmente revertibile e va fatto subito dopo una release stabile.

## 8. Rischi e mitigazioni

| Rischio | Probabilità | Mitigazione |
|---|---|---|
| Accoppiamento globale renderer rompe l'ESM | Alta | Sotto-fase 6a precede ogni conversione; iniezione dipendenze completata prima |
| Regressione performance caricamento renderer | Media | Budget esplicito in 6a; benchmark prima/dopo; fallback: precompilazione senza modifiche di struttura |
| Tipi mancanti/errati di dipendenze native (`node-pty`, `adm-zip`) | Media | Dichiarazioni locali in `src/shared/vendor-types/`; mai `any` silenzioso: `unknown` + narrowing |
| Coverage scopes falsati dal remapping | Media | Ricalibrazione in M7 con confronto numerico pre/post |
| Doppio albero genera drift JS/TS | Media | Gate CI: in directory convertite i `.js` sono vietati (check in `scripts/quality.js`) |
| Refactor architetturali (A1–A5) slittano e bloccano la conversione | Media | Sono prerequisiti solo di A1→M3 e A2/A3→6a; se un refactor supera il suo slot, si converte lo stato attuale e il refactor torna in backlog — mai conversione e refactor insieme |
| Slittamento per review lente | Alta | Milestone piccole, commit atomici per file, branch di lunga vita vietati |

## 9. Metriche di successo

- 0 file `.js` in `src/` a fine M8 (eccezioni documentate).
- `strict: true` su tutto l'albero; baseline errori eliminata.
- `npm run quality:full` verde in ogni commit mergiato.
- Nessun cambio di comportamento pubblico dimostrato dai contract test invariati
  (possono crescere di asserzioni statiche, non cambiare semantica).
- Benchmark perf renderer/workspace/memory entro budget dichiarati.
- A2 completato: `app.js` sotto ~200 righe, nessun componente che legge `app.state` o chiama
  `app.emit` direttamente; A1 completato: nessun monkey-patching su prototipi.
- Contratti IPC con forma runtime invariata (contract test non modificati nella semantica).
