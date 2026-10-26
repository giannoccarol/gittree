# Pubblicare una release di GitTree

Questa guida descrive il percorso supportato per produrre installer locali o pubblicare una release ufficiale con aggiornamenti OTA.

## Prerequisiti

- Node.js 22 o successivo.
- npm e Git disponibili nel `PATH`.
- Working tree pulito.
- Versione SemVer coerente in `package.json`.
- Per le release ufficiali: repository GitHub `giannoccarol/gittree`.
- Client ID pubblici di GitHub App e GitLab OAuth Application.
- Per macOS OTA: certificato Developer ID e credenziali Apple per la notarizzazione.
- Per eliminare gli avvisi Windows: certificato Authenticode oppure adesione a un servizio gratuito per progetti open source come SignPath Foundation.

## Controlli prima della release

```powershell
npm ci
npm run validate
npm run prepare:assets
```

`prepare:assets` controlla che `icon.png` sia quadrata, abbia almeno 512×512 pixel e contenga un canale alpha. Copia quindi il master in `build/icon.png`, da cui electron-builder genera le varianti native. Genera inoltre `build/oauth-config.json` usando esclusivamente client ID pubblici.

Per verificare una build locale con OAuth:

```powershell
$env:GITTREE_GITHUB_CLIENT_ID = "client-id-pubblico"
$env:GITTREE_GITLAB_CLIENT_ID = "application-id-pubblico"
npm run prepare:assets
npm run build
```

Non aggiungere client secret: Device Flow non li richiede e GitTree non li legge.

## Build locali

Build non installabile, utile per verificare il contenuto dell’app:

```powershell
npm run build
```

Installer per il sistema operativo corrente:

```powershell
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Gli artefatti vengono scritti in `dist/` e non vengono pubblicati.

## Release automatica con semantic-release

La release ufficiale viene generata automaticamente a ogni push su `master` tramite
[semantic-release](https://semantic-release.gitbook.io/).

### Schema di versione

GitTree segue SemVer standard a partire dalla **`1.0.0`**, la dichiarazione di
stabilità che chiude la fase di anteprima `0.x.y`.

- i **breaking change** (`feat!:`/`fix!:` o footer `BREAKING CHANGE:`) producono una **major** (`1.4.2` → `2.0.0`);
  il primo breaking change dopo `0.30.x` porta quindi la linea a `1.0.0`;
- le **nuove funzionalità** (`feat:`) producono una **minor** (`1.0.3` → `1.1.0`);
- `fix:`, `perf:`, `refactor:` e `style:` producono una **patch** (`1.0.0` → `1.0.1`);
- `docs:`, `chore:`, `test:`, `ci:`, `build:` non aprono una release.

Non creare tag a mano e non usare `npm version` per i rilasci ufficiali: lo fa il workflow.

Il workflow `.github/workflows/versioning.yml` esegue semantic-release che:
1. analizza i commit dall’ultimo tag SemVer raggiungibile su `master`;
2. determina la versione successiva dalle regole Conventional Commits;
3. aggiorna `package.json` e `package-lock.json`;
4. crea un commit `chore(release): X.Y.Z` attribuito al maintainer Lorenzo Giannoccaro;
5. pusha il tag `vX.Y.Z`.

La GitHub Release resta pubblicata da `github-actions[bot]`: questa identità indica
che gli artefatti provengono dalla pipeline verificata, mentre autore e committer
del commit di versione restano attribuiti al maintainer.

Il push del tag attiva `.github/workflows/release.yml` che:

1. verifica che il tag `vX.Y.Z` coincida con `package.json`;
2. verifica la presenza dei client ID OAuth pubblici;
3. esegue il gate di rilascio scoped (contract test, audit design, lint) —
   la suite completa è già eseguita dal CI sullo stesso commit;
4. crea una sola GitHub Release in stato draft;
5. costruisce Windows, macOS e Linux sui rispettivi runner;
6. valida separatamente installer, payload e manifest OTA;
7. carica gli asset direttamente nella draft;
8. pubblica la release soltanto dopo il successo di tutte le piattaforme.

Se una build fallisce, la release resta draft e non viene rilevata dai client. Un nuovo avvio dello stesso workflow riutilizza la draft, elimina gli asset incompleti e ricostruisce tutto. Una release già pubblicata non viene mai sovrascritta.

Non creare manualmente un tag che non corrisponde alla versione del pacchetto: `release:check` bloccherebbe la pipeline.

Configurare come GitHub Actions repository variables:

- `GITTREE_GITHUB_CLIENT_ID`;
- `GITTREE_GITLAB_CLIENT_ID`.

La release fallisce se mancano o contengono valori non validi. Il file generato viene incluso come `oauth-config.json` nelle risorse pacchettizzate.

## Artefatti

| Sistema | Artefatti | OTA |
| --- | --- | --- |
| Windows x64 | Installer NSIS assistito | Sì |
| macOS x64/arm64 firmato | DMG, ZIP e manifest | Sì |
| macOS x64/arm64 non firmato | DMG | No, download manuale |
| Linux x64 | AppImage, DEB e pacchetto Pacman | AppImage |

I nomi seguono lo schema `GitTree-versione-sistema-architettura.estensione`. Il pacchetto `.pacman` è installabile su Arch Linux e derivate con `sudo pacman -U`; l’AppImage resta il payload usato per gli aggiornamenti OTA.

La selezione degli asset è intenzionalmente restrittiva: file di debug e configurazioni interne di electron-builder non vengono caricati. Per verificare una build Windows locale senza pubblicarla:

```powershell
npm run release:assets -- --platform win --directory dist --tag v0.1.0 --dry-run
```

## Firma e notarizzazione

Configurare i seguenti GitHub Actions secrets:

- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`
- `MACOS_CSC_LINK`
- `MACOS_CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Windows e Linux possono utilizzare gli aggiornamenti GitHub senza un servizio a pagamento. Una build Windows non firmata può mostrare SmartScreen; GitTree può candidarsi alla firma gratuita di [SignPath Foundation](https://signpath.org/) dopo la prima release pubblica documentata.

### Firma Windows con SignPath Foundation (gratuita per open source)

1. Registrare il progetto su [SignPath](https://signpath.org/) e configurare una signing policy.
2. Configurare i GitHub Actions secrets:
   - `SIGNPATH_API_TOKEN`;
   - `SIGNPATH_ORG_ID`;
   - `SIGNPATH_SIGNING_POLICY_ID`.
   E la repository variable obbligatoria `SIGNPATH_PROJECT_SLUG`, che identifica
   il progetto configurato su SignPath indipendentemente dal nome GitHub.
3. Dopo la pubblicazione di una release, eseguire manualmente il workflow
   `Sign Windows installer` indicando il tag: scarica l'installer NSIS dalla
   release, lo invia a SignPath, attende la firma e sostituisce l'asset nella
   release (come `-signed.exe`).
4. Verificare la firma con `Get-AuthenticodeSignature` prima di distribuire.

Su macOS `electron-updater` richiede un’app firmata. Quando i secret macOS non sono configurati, la pipeline carica soltanto i DMG per l’installazione manuale e omette deliberatamente ZIP e `latest-mac.yml`: non viene quindi pubblicato un feed OTA destinato a fallire. L’OTA macOS si abilita automaticamente quando sono presenti tutti i secret di firma e notarizzazione.

La quota Apple Developer resta l’unico costo non eliminabile se si vuole distribuire un OTA macOS ufficiale.

## Release candidate e prerelease

Versioni come `1.2.0-beta.1` vengono pubblicate automaticamente come prerelease. Una build stabile non accetta automaticamente downgrade o prerelease; una build beta continua invece a controllare il proprio canale prerelease.

## Verifica post-release

1. Installare la release su una macchina pulita.
2. Controllare icona, collegamenti e disinstallazione.
3. Avviare l’app e aprire una repository reale.
4. Pubblicare una versione patch successiva.
5. Verificare comparsa, download e installazione dell’aggiornamento.
6. Conservare la release precedente finché il rollout non è stato validato.
