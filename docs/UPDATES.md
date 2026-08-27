# Architettura degli aggiornamenti OTA

GitTree utilizza `electron-updater` e i manifest generati da electron-builder nelle GitHub Releases.

## Flusso applicativo

1. Il controllo è attivo solo quando `app.isPackaged` è vero.
2. La prima verifica avviene dopo 15 secondi, quindi ogni sei ore.
3. Una versione disponibile viene mostrata nella barra comandi.
4. Il download parte soltanto dopo l’azione dell’utente.
5. L’installazione richiede un secondo comando esplicito di riavvio.
6. Se l’utente chiude normalmente l’app dopo il download, l’aggiornamento resta pronto per l’installazione.

Su Windows (`oneClick: false`) l’installazione fresh mantiene il wizard assistito (directory inclusa). Gli aggiornamenti lanciati da `quitAndInstall(false, true)` passano `--updated`: `build/installer.nsh` salta install-mode e finish page, lascia solo la progress bar e riavvia l’app.

Su Linux, `quitAndInstall` è supportato solo per AppImage. I pacchetti Pacman e DEB aprono la pagina GitHub Releases, perché `electron-updater` non può sostituire in sicurezza un’installazione nativa (errore 127). Dopo un aggiornamento, il single-instance lock passa la versione alla nuova istanza: se parte un binario più recente mentre il vecchio processo è ancora attivo, l’istanza precedente si rilancia dal file installato e termina.

Il renderer non riceve URL arbitrari e non può eseguire comandi di aggiornamento raw. Le uniche IPC esposte sono:

- `update:get-state`
- `update:check`
- `update:download`
- `update:install`

## Stati

`disabled → idle → checking → available → downloading → downloaded`

Gli errori manuali passano a `error`; gli errori dei controlli periodici non interrompono il lavoro dell’utente.

## Artefatti richiesti

La pipeline atomica valida e pubblica:

- `latest.yml` per Windows;
- `latest-mac.yml` e ZIP per macOS soltanto quando firma e notarizzazione sono configurate;
- `latest-linux.yml` per Linux;
- installer, AppImage, pacchetto Pacman, DMG e relativi file `.blockmap`.

Non rinominare o rimuovere manualmente i manifest da una release.

Ogni release nasce come draft. Windows, macOS e Linux caricano i rispettivi asset direttamente nella draft; il job finale la pubblica solo quando tutti i job sono riusciti. Una build fallita non è quindi visibile a `electron-updater`.

Le build macOS non firmate pubblicano esclusivamente il DMG manuale. Omettere il manifest impedisce che i client ricevano un aggiornamento che macOS rifiuterebbe.

## Sicurezza

- Il provider è vincolato al repository GitHub configurato in `electron-builder.yml`.
- I manifest contengono hash degli artefatti.
- I downgrade sono disabilitati.
- Le prerelease sono accettate solo da una versione che appartiene già a un canale prerelease.
- La firma del codice deve essere configurata prima della distribuzione pubblica.
- Nessun token di pubblicazione o aggiornamento viene distribuito dentro l’app: il repository di aggiornamento deve rimanere pubblico per questo modello.
- Il token GitHub Actions ha permesso di scrittura soltanto nei job che creano o aggiornano la release.
- I client ID OAuth pubblici inclusi nella build non autorizzano la pubblicazione di release e sono separati dai token utente cifrati a runtime.

## Costi operativi

Con un repository pubblico, GitHub Releases ospita installer e manifest e GitHub Actions esegue le build sui runner standard senza richiedere un server applicativo. Windows può partire unsigned e candidarsi successivamente alla firma gratuita SignPath per progetti open source. Linux non richiede un certificato commerciale. La firma e notarizzazione macOS richiedono invece l’adesione Apple appropriata.

## Rollback

Un rollback non deve riutilizzare lo stesso numero di versione. Pubblicare una nuova patch contenente il codice stabile precedente. La modifica di un artefatto già pubblicato rende ambiguo il manifest e deve essere evitata.

## Provider futuro

Per migrare a S3 o a un update server dedicato:

1. cambiare il blocco `publish`;
2. mantenere invariati i canali IPC e la macchina a stati;
3. verificare manifest per ogni piattaforma;
4. non introdurre credenziali permanenti nel renderer o nel pacchetto.
