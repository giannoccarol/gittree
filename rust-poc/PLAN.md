# POC Rust + GPUI (Linux/Windows)

Obiettivo: validare su un perimetro minimo le parti ad alto valore di GitTree prima di
eventuali migrazioni. Il POC vive solo in `rust-poc/`, fuori dal path di build/typecheck
di `npm run quality`, e non modifica alcun comportamento esistente.

## Perimetro: le funzioni più importanti da migrare per prime

Ordinate per valore/rischio (prima le funzioni pure, poi il motore Git, poi la UI):

1. **Parser puri** (zero rischio, testabili con golden files)
   - `src/main/git/patch-parser.mts`, `blame-parser.mts`
   - `src/renderer/components/diff-parser.mts`
2. **Motore Git** (il vero target della migrazione)
   - `repository-operations.mts`: status, stage/unstage, commit, branch
   - `repository-history.mts`: log/graph dati
   - `repository-worktrees.mts`, `repository-working-tree.mts`
   - `repository-queue.mts`: coda seriale per repository (semantica da preservare)
3. **Repository scanner** (`repository-scanner.mts`): scan workspace, candidato perfetto
   per threading nativo.
4. **Shell GPUI** (solo prova UI stack): una finestra con lista branch + log commit +
   diff testuale alimentati da `gittree-core`. Nessuna parità con il renderer attuale.

Non in perimetro: hosting/OAuth, AI/agents, credential vault, auto-update, i18n completa,
settings, conflict resolver interattivo.

## Struttura

```
rust-poc/
  Cargo.toml            # workspace
  crates/
    gittree-core/       # parser + operazioni git (spawn del binario git) + scanner
    gittree-sidecar/    # binario stdio JSON-RPC, envelope { error } compatibile
    gittree-gpui/       # finestra GPUI minimale (Linux X11/Wayland + Windows)
  PLAN.md               # questo documento
```

## Milestone

- **M0 — Scaffold**: workspace Cargo, CI-check locale `cargo test && cargo clippy`.
- **M1 — Parser**: port dei 3 parser come funzioni pure; golden test confrontando
  output su fixture reali identiche a quelle dei test TS esistenti.
- **M2 — Motore Git**: status/log/branch/worktree con spawn di `git`; coda per-repo;
  test su repository temporanei reali (stesso approccio dei test node:test attuali).
- **M3 — Sidecar**: protocollo stdio JSON-RPC + client TS opzionale in `src/main/git/`
  dietro feature flag, riusando l'envelope `{ error }`; nessun handler esistente cambia path.
- **M4 — GPUI**: `gittree-gpui` legge dallo stesso `gittree-core` e mostra branch list +
  log + diff. Gate di accettazione: compilazione e avvio su **Linux (X11 o Wayland)**
  e **Windows 10/11**, scroll fluido su repo di ~10k commit.
- **M5 — Benchmark**: status + log full su repo grande, TS vs Rust sidecar; numeri nel
  README del POC per decidere se proseguire.

## Decisioni aperte (da chiudere col POC)

- **Sidecar vs napi-rs**: il POC usa sidecar (isolamento crash, stesso modello IPC);
  napi-rs resta alternativa se la latenza stdio pesa.
- **spawn git vs gitoxide**: POC parte con spawn `git` per parità semantica col TS;
  gitoxide valutato solo in M5.
- **GPUI su Linux/Windows**: rischio principale del POC (API instabili, docs scarse).
  M4 è il gate go/no-go: se fallisce, il fallback è Tauri o restare Electron.

## Criteri di successo

1. Golden test dei parser verdi, output identico al TS.
2. Motore Git al pari funzionale sul sottoinsieme scelto, con coda seriale equivalente.
3. Finestra GPUI funzionante su Linux e Windows senza workaround instabili.
4. Benchmark che quantifichi il guadagno reale (atteso: scanner e log, non status singoli).
