# Esito POC (aggiornato al termine dell'esecuzione)

Stato per milestone su Linux (Fedora, Wayland/X11, Rust stable 1.98):

- **M0 Scaffold** — completato. Workspace con 3 crate, build da cold cache ~2 min
  (gittree-gpui tira l'intero albero gpui; core e sidecar compilano in secondi).
- **M1 Parser** — completato. Port di patch/blame/diff parser come funzioni pure.
  Golden test: gli output Rust vengono confrontati campo per campo con JSON generati
  dall'implementazione TypeScript reale (`scripts/gen-goldens.mjs`, Node >= 22.18)
  su fixture Git deterministiche (`scripts/make-fixtures.sh`). Inclusi casi limite:
  binary patch, `\ No newline at end of file`, range omessi, quirk dello split finale,
  propagazione della proprietà `type` in `numberHunk`.
- **M2 Motore Git** — completato. `graph.page` (log `-z` + refs + HEAD sintetico),
  status porcelain v2, stage/unstage/commit, validazione ref/path, coda seriale
  per-repository. Test su repository reali temporanei e deterministici.
- **M3 Sidecar** — completato. NDJSON su stdio con envelope `{ error }`; sopravvive
  a richieste malformate e metodi sconosciuti. Client TS dimostrativo in `client/`
  (non cablato in produzione). Test end-to-end sul processo reale.
- **M4 GPUI** — completato su Linux. Finestra nativa con lista commit + diff
  colorato, scroll e frecce ↑/↓. Avviata su Wayland/X11: nessun crash né output
  su stderr, anche con repository da 5.000 commit.
  ⚠️ **Non ancora verificato su Windows**: serve una macchina Windows con
  toolchain MSVC; è il prossimo gate prima di ogni decisione.
- **M5 Benchmark** — completato (repo 5k commit, sidecar release, 20 iterazioni):
  - graph.page completo (log 500 + refs + HEAD): TS simple-git 39.2 ms vs Rust 38.6 ms → **parità**
  - status completo: TS 2.0 ms vs Rust 1.4 ms → **Rust -30%**
- **M6 Da POC ad applicazione** — completato su Linux. Il crate `gittree-gpui`
  replica il layout dell'app Electron e le sue funzioni principali:

  - Layout fedele a `index.html`: header con tab repository, command bar
    (Branches / Fetch / Pull ↓behind / Push ↑ahead / Inspector), sidebar Branches
    con ricerca e sezione Tags, toolbar con segmented History | Changes (+badge),
    inspector con meta commit, file modificati e diff, status bar con dot di stato,
    branch, ahead/behind ed esito operazioni. Tema dark e light con i token reali
    di `variables.css` (toggle nell'header).
  - Funzionalità: selezione commit da lista o frecce ↑/↓ con diff nel inspector;
    filtro commit per messaggio/hash/autore; vista Changes con split staged/unstaged,
    stage/unstage per file e Stage all / Unstage all / Discard all (doppio click
    di conferma); composer con summary/body, Amend HEAD, Sign-off e Commit;
    checkout branch dalla sidebar (bloccato con working tree sporco), creazione
    nuova branch inline; Fetch/Pull (`--ff-only`)/Push (`-u`) con esito in status bar.
  - Nuove primitive in `gittree-core`: `get_status_detail` (split staged/unstaged,
    upstream, ahead/behind), `checkout`, `create_branch`, `delete_branch`,
    `discard`, `fetch_all`, `pull`, `push`, `commit_with_options` (amend/sign-off),
    `head_diff`. Tutte testate su repository reali temporanei, incluso remote bare
    locale per fetch/pull/push end-to-end.
  - Prestazioni: tutte le operazioni git girano su thread background
    (`background_spawn`) con un unico `GitEngine` condiviso e la coda seriale
    per-repository per le scritture; lista commit, liste file, branch e righe di
    diff sono virtualizzate (`uniform_list`); modelli riga (hash corto, soggetto,
    autore, data relativa, haystack filtrabile lowercase, chip refs) calcolati una
    sola volta per refresh; lane grafo calcolate una sola volta a caricamento pagina.

  Non ancora portato (resta sull'app Electron): pull request view, GitFlow,
  terminale integrato, agent workspace, merge/conflict resolver, contest menu,
  finestra inspector separata, i18n (UI solo inglese), icone Phosphor (il port usa
  label testuali e glifi Unicode).

## Conclusioni

1. La migrazione dei moduli puri è a basso rischio e verificabile al 100% con golden test.
2. Il collo di bottiglia reale sono gli spawn del binario git (3 processi/richiesta da
   entrambi i lati): portare i parser in Rust senza eliminare gli spawn non dà guadagni.
   Il salto arriva con gitoxide o riusando un processo git batch (`--literal-pathspecs`
   + protocollo v2), non dal solo port.
3. GPUI è utilizzabile su Linux oggi; API stabili ma documentazione minima e binario
   debug enorme (~520 MB). Il gate Windows resta aperto.
4. Con M6 l'app GPUI copre il flusso quotidiano (history, changes, commit, sync,
   branch) restando ~10x più leggera dell'app Electron a runtime; le viste avanzate
   (PR, merge, agent) richiedono prima il gate Windows e un protocollo sidecar esteso.
5. Verifica completa: `cd rust-poc && cargo test && cargo clippy --workspace --all-targets`
   (33 test verdi, zero warning clippy sui crate del workspace).

Per riprodurre:

```bash
rust-poc/scripts/make-fixtures.sh          # fixture deterministiche
node rust-poc/scripts/gen-goldens.mjs      # golden dall'implementazione TS reale
cd rust-poc && cargo test                  # tutti i test
cargo run -p gittree-gpui -- /percorso/repo   # app GPUI completa
node rust-poc/scripts/bench-ts.mjs <repo>     # benchmark TS
node rust-poc/scripts/bench-sidecar.mjs <repo> # benchmark sidecar
```
