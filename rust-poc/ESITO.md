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

## Conclusioni

1. La migrazione dei moduli puri è a basso rischio e verificabile al 100% con golden test.
2. Il collo di bottiglia reale sono gli spawn del binario git (3 processi/richiesta da
   entrambi i lati): portare i parser in Rust senza eliminare gli spawn non dà guadagni.
   Il salto arriva con gitoxide o riusando un processo git batch (`--literal-pathspecs`
   + protocollo v2), non dal solo port.
3. GPUI è utilizzabile su Linux oggi; API stabili ma documentazione minima e binario
   debug enorme (~520 MB). Il gate Windows resta aperto.
4. Verifica completa: `cd rust-poc && cargo test && cargo clippy --workspace --all-targets`
   (29 test verdi, zero warning clippy sui crate del workspace).

Per riprodurre:

```bash
rust-poc/scripts/make-fixtures.sh          # fixture deterministiche
node rust-poc/scripts/gen-goldens.mjs      # golden dall'implementazione TS reale
cd rust-poc && cargo test                  # tutti i test
cargo run -p gittree-gpui -- /percorso/repo   # finestra GPUI
node rust-poc/scripts/bench-ts.mjs <repo>     # benchmark TS
node rust-poc/scripts/bench-sidecar.mjs <repo> # benchmark sidecar
```
