# Piano UI "impeccable": consistenza ed estetica

Branch di lavoro: `ui/impeccable`. Nasce dal merge delle quattro varianti del primo giro: `ui/modal-anatomy`, `ui/type-scale`, `ui/button-system` e `ui/english-copy`, tutte basate su `feat/desktop-app@352d767`. Ogni merge ha il suo commit, quindi una variante scartata si toglie con un `git revert -m 1 <merge>`. Il merge lo fa lo step M.

## Ordine di esecuzione

| Fase | Step | Parallelismo |
| --- | --- | --- |
| Wave 0 | M (merge) → 0a (DESIGN.md, consolidamento, audit) | sequenziali; 0b (harness) in parallelo a entrambi |
| Wave 1 | S1, S2, S3, S4, S5, ognuno con varianti A e B | 5 agenti in parallelo, poi 5 revisori |
| Gate | l'utente sceglie A/B/nessuna nell'hub | — |
| Wave 2 | merge dei vincitori → S6 → S7 | sequenziali |

Tutti gli agenti sono Opus 5.5 con effort high.

## Obiettivo

Gli stessi elementi devono essere uguali in tutta l'app: card, bottoni, riquadri, chip, tab, titoli, sezioni dei modali. In più va tolta la ridondanza. L'esempio tipico è la pagina Overview › Outfits, dove la posizione è ripetuta a quattro livelli:

- la pill "OVERVIEW" nella navigazione in alto;
- l'h1 "Overview";
- il tab "Outfits";
- l'h2 "Outfits 5".

Bastano uno o due livelli.

## Vincoli, validi per ogni step

- **Palette.** Si tiene quella attuale: i token in `src/styles.css` `:root`, cioè `--paper*`, `--ink*`, `--muted`, `--line`, `--accent` #6e302e, `--accent-warm`, `--success`, `--error`. Non si aggiungono nuovi colori di brand.
- **Stile.** Si tiene lo stile glass con bordi tondi: i token `--glass-*`, `--r-xs…--r-full`, `--shadow-*` e `GlassFilter.jsx`. Si raffina, non si sostituisce.
- **Modalità impeccable: Operate.** È un'app con dei task, quindi l'ambizione si vede nella precisione e nella sobrietà. Pattern noti, nessun effetto decorativo nuovo.
- **Cosa resta uguale.** Comportamento, dati, API e testi fattuali non cambiano. Fanno eccezione i titoli e le etichette ridondanti che uno step rimuove esplicitamente.
- **Zone vietate.** Non si toccano `desktop/`, `src/prototypes/`, `scripts/` (il server) e `data/`.
- **Base del primo giro.** Si costruisce sopra le regole già introdotte: la scala `--text-*`, le classi bottone di `src/components/buttons.css` e l'anatomia header/body/footer di `ViewerPanel`. Non si reintroducono valori fuori scala.
- **Skill.** Ogni agente carica la skill `impeccable` (`.claude/skills/impeccable/SKILL.md`). Lancia `impeccable context` una volta, legge `reference/craft-floor.md` prima di ogni modifica alla UI e la reference del comando indicato nello step.
- **Varianti.** Per ogni punto ambiguo si fanno due varianti, A e B. Le dettaglia lo step, e l'utente sceglie quale tenere.
- **Test e build.** `node --test test/*.test.mjs` non deve dare nuovi fallimenti rispetto alla base: il primo giro ha misurato 43 fallimenti già presenti, tutti di Drive e del server. Anche `npx vite build` deve passare.

## Infrastruttura: harness già pronto

L'harness è in `Z:\Repo-personal\wardrobe-variants\`. Le istruzioni sono in `_tools/README.md` e gli stati catturati in `_tools/TOUR.md`.

Cosa offre:
- dati demo;
- server isolati, senza chiavi reali e senza spesa;
- un tour Playwright di 62 stati a 1440×900 e 390×844, con `metrics.json`;
- un hub su http://127.0.0.1:5300.

Per questo giro (lo prepara lo step 0b):

| Nome | Branch | Porta |
| --- | --- | --- |
| `impeccable-base` (nuova baseline) | `ui/impeccable` | 5320 |
| `s1-page-shell-a` / `-b` | `ui/impeccable-s1-a` / `-b` | 5321 / 5322 |
| `s2-cards-a` / `-b` | `ui/impeccable-s2-a` / `-b` | 5323 / 5324 |
| `s3-controls-a` / `-b` | `ui/impeccable-s3-a` / `-b` | 5325 / 5326 |
| `s4-modal-content-a` / `-b` | `ui/impeccable-s4-a` / `-b` | 5327 / 5328 |
| `s5-popovers-a` / `-b` | `ui/impeccable-s5-a` / `-b` | 5329 / 5330 |

Ogni variante ha il suo worktree in `wardrobe-variants/<nome>`, con `node_modules` collegato come junction. L'orchestratore crea i worktree dopo lo step 0 e ogni agente lavora solo nei propri.

Alla fine ogni agente:
1. fa il commit sul proprio branch, senza push;
2. lancia `node _tools/start-variant.mjs <nome> --build`, poi il tour completo verso `_shots/<nome>`;
3. scrive `_shots/<nome>/NOTES.md` in italiano: cosa ha cambiato, perché, e la differenza tra A e B;
4. ricostruisce l'hub.

## Wave 0: fondamenta (sequenziale, prima di tutto il resto)

### Step M: unione del primo giro (1 agente, worktree `wardrobe-variants/impeccable-base`)

1. **Ordine dei merge.** Su `ui/impeccable` (che parte da `352d767` più questo piano) unisce, con `git merge --no-ff`, i branch `ui/type-scale`, `ui/button-system`, `ui/modal-anatomy` e `ui/english-copy`, in quest'ordine.
2. **Conflitti.** Si aspettano circa 27 conflitti in 13 file, soprattutto tra type-scale e button-system, sulle stesse regole CSS.
   - Regola: la dimensione del testo viene da `--text-*` (type-scale) e la forma e lo stato del bottone da `buttons.css` (button-system).
   - Nessun valore px nuovo per `font-size`.
   - Le REVIEW.md in `_shots/<variante>/` hanno la mappa dei conflitti.
3. **Correzioni minori.** Applica le note di gravità bassa ancora aperte nelle REVIEW.md, ciascuna in un commit separato dopo i merge.
4. **Verifica.**
   - Test: nessun nuovo fallimento rispetto ai 43 della baseline.
   - Build verde.
   - Tour completo di `impeccable-base` (porta 5320, quando 0b l'ha registrata; prima di allora un controllo manuale).
   - Controllo dello scroll dei modali con `check-modal-scroll.mjs`: titolo e X restano visibili in ogni stato.
5. **Push** di `ui/impeccable`.

### Step 0a: sistema documentato e audit (1 agente, nel repo, su `ui/impeccable`)

1. **`impeccable document`.** Genera `DESIGN.md` e il suo sidecar a partire dal codice di `ui/impeccable`, già unito. Deve coprire:
   - palette;
   - superfici glass, con i livelli card, chrome, panel e sheet;
   - radius;
   - ombre;
   - scala tipografica;
   - vocabolario dei bottoni;
   - anatomia dei modali.

   `PRODUCT.md` lo ricava da README e AGENTS.md e marca come "da confermare" ciò che deduce.
2. **Consolidamento senza cambi visivi.** Ogni radius, ombra, gap o padding che corrisponde a un token esistente diventa quel token. I valori orfani si elencano, senza deciderli. Diff visivo atteso: zero o quasi zero.
3. **Audit di ridondanza e incoerenza.** Usa `impeccable critique` e `impeccable audit` sugli screenshot di `_shots/impeccable-base` (prima li rigenera) e sul codice. Scrive `docs/impeccable/audit.md` con i problemi per pagina o modale, gravità P0–P3 e lo step a cui appartengono (S1–S5).
4. **Inventario dei componenti.** Scrive `docs/impeccable/components.md`. Per ogni famiglia (card, chip/pill, tab, segmented, campo, riga chiave/valore, etichetta di sezione, badge, menu) elenca le varianti esistenti con file e riga, e quale sarà la forma canonica.
5. **Commit su `ui/impeccable`.**

Lo step 0a parte dopo M.

### Step 0b: estensione dell'harness (1 agente, fuori dal repo, in parallelo a M e 0a)

- `variants.mjs` diventa a "round": ogni variante dichiara la propria `baseline`. Il round 1 resta confrontato con `before`; il round 2 con `impeccable-base`.
- L'hub mostra un tab per round. Ogni variante ha accanto A e B e la loro baseline: link live, galleria a coppie, NOTES.md e REVIEW.md, e la scelta "A / B / nessuna" salvata in localStorage ed esportabile.
- Registra le varianti e le porte della tabella sopra. Nessun worktree: li crea l'orchestratore.

## Wave 1: miglioramenti con varianti (5 agenti in parallelo)

Ogni step ha un file di proprietà. Si modificano solo quelli dichiarati, per poter unire liberamente qualunque combinazione di A e B. Se servono primitive condivise in `src/styles.css`, si scrivono solo dentro un blocco commentato `/* == S<n> ... == */` dello step.

### S1: shell delle pagine e gerarchia (Wardrobe, Overview, Inspo, barra in alto, header e nav mobile)

**Problemi:**
- Overview mostra la posizione quattro volte: nav, h1, tab, h2.
- Wardrobe su desktop non ha un titolo ma un eyebrow "20 PIECES", mentre su telefono ha l'h1 "Wardrobe".
- Inspo mette la pill "SOURCES (5)" dentro la riga delle categorie.
- Le tre pagine hanno un header diverso.

**Comando impeccable:** `layout` + `distill`.

**Variante A, "i tab sono il titolo":**
- Su desktop niente h1, perché la nav dice già dove sei.
- I sotto-tab diventano l'intestazione della pagina: più grandi, con il conteggio ("Outfits 5"), sulla stessa riga delle azioni, allineate a destra.
- Nessun h2 di sezione.
- Wardrobe e Inspo: conteggio e filtri su una sola riga. In Inspo "Pieces / Sources" diventano due tab come in Overview.

**Variante B, "titolo + segmented":**
- Un solo h1 per pagina con il nome del contenuto corrente ("Outfits"), il conteggio come caption.
- La sotto-navigazione è un segmented glass: lo stesso componente della nav in alto, in piccolo, accanto al titolo. Le azioni stanno a destra.
- Spariscono la barra dei tab e l'h2.
- Wardrobe ha "Wardrobe · 20"; Inspo ha "Inspo" con il segmented "Pieces / Sources", separato dalle categorie.

**Entrambe:**
- su telefono stessa logica, con `MobileHeader` coerente;
- un solo h1 per vista;
- azioni con al massimo un primario.

**File:** `App.jsx` (solo la parte header delle pagine), `components/PageShell.jsx`, `MobileHeader.jsx`, `BottomNav.jsx`, `mobile-chrome.css`, `overview.jsx`, `overview.css`, `inspo.jsx` (solo l'header), la sezione header/topbar di `styles.css`.

**Stati da controllare:** 01–09.

### S2: card e griglie

**Problemi:** le card dei capi (Wardrobe, Pieces, Inspo), degli outfit, dei cheat sheet, le hot card ("My colours", "Declutter") e le tile del picker hanno superfici, radius, padding, caption e badge diversi. Ne fanno parte i puntini del carosello sotto la card, che spostano la caption, e il badge "Retry" che esce dalla card.

**Comando impeccable:** `polish` + `layout`.

**Variante A, "caption sotto":**
- La caption resta fuori dalla card ma diventa identica ovunque: nome, poi meta in caption, con altezza fissa così la griglia resta allineata.
- I puntini del carosello vanno dentro l'immagine.
- Badge e azioni di stato stanno dentro la card, in alto a destra.

**Variante B, "card unica":**
- La caption entra nella card, in un piede glass in basso: un solo oggetto, un solo bordo.
- Le hot card e le card dei cheat sheet usano la stessa superficie.

**Entrambe:**
- un solo componente o classe base di card con varianti dichiarate (garment, outfit, sheet, hot, picker tile);
- stati hover, selezione e focus uguali;
- il checkbox di selezione è identico in Pieces e nel picker.

**File:** la sezione grid/card di `styles.css`, `components/hot-cards.css`, `HotCards.jsx`, `OutfitStack.jsx`, `piece-picker.css` (solo le tile), `outfits.css` (solo la griglia), `cheat-sheets.css` (solo la griglia), `inspo.css` (solo la griglia), `wishlist.css`.

**Stati da controllare:** 01–09, 28, 31, 46.

### S3: filtri, chip e controlli

**Problemi:**
- Le pill delle categorie sono tutte maiuscole e la riga è lunghissima su desktop.
- "MATCHES MY COLORS" è un filtro di natura diversa, ma ha lo stesso aspetto delle categorie.
- I chip dei tag e degli stili hanno ognuno uno stile diverso: "cotton" nel viewer, "CASUAL" nell'outfit.
- Ci sono almeno tre tipi di tab: la nav in alto, i tab di Overview e i tab di Settings.
- Il campo di ricerca e gli input non hanno un aspetto unico.

**Comando impeccable:** `distill` + `typeset` (solo per le etichette dei controlli).

**Variante A, "chip leggeri":**
- Chip in sentence case, più bassi.
- Lo stato selezionato è pieno con `--ink`.
- Su tutte le larghezze la riga scorre orizzontalmente con una sfumatura ai bordi.
- "Matches my colors" diventa un toggle separato da un divisore.

**Variante B, "track glass":**
- Le categorie stanno in una sola traccia glass a scorrimento, come un segmented lungo, con lo stesso linguaggio della nav in alto.
- I filtri trasversali ("Matches my colors", "Sources" se S1 non li ha spostati) vanno in un bottone "Filter" con un menu.

**Entrambe:**
- un solo stile di chip per i tag (read-only ed editabile);
- un solo stile di campo per testo, ricerca e select;
- i tab dentro i modali (Settings, Declutter, Inspo importer) sono un solo componente.

**File:** `src/components/chips.css` (nuovo) e `src/components/fields.css` (nuovo), più la sostituzione delle classi nei JSX che usano chip, tab o campi. Non si tocca la struttura degli header, che è di S1.

**Stati da controllare:** 01, 03, 06, 08–14, 19, 25, 35, 39, 51.

### S4: contenuto dei modali principali

**Problemi:**
- I titoli dei modali sono a volte in maiuscolo ("SATURDAY ERRANDS", "WHITE OXFORD SHIRT", "SETTINGS") e a volte no.
- Le etichette di sezione sono di tre tipi: eyebrow "CATEGORY", "3 PIECES", "WAYS TO WEAR IT · 3".
- Ogni modale ha le sue righe chiave/valore.
- La posizione delle azioni cambia: Delete/Edit/Wore it inline nell'outfit e menu ⋯ nel capo.

**Comando impeccable:** `layout` + `clarify` (etichette).

**Variante A, "etichette eyebrow":**
- Il pattern attuale, rifinito: etichetta eyebrow con separatori sottili.
- Le righe sono chiave a sinistra e valore a destra, con il chevron.
- Le azioni dell'oggetto stanno sempre nel footer fisso, con il distruttivo a sinistra.

**Variante B, "gruppi titolati":**
- Le sezioni hanno un titolo `--text-section` in sentence case.
- Il contenuto sta in pannelli glass interni raggruppati, come liste a gruppi.
- Le azioni secondarie vanno nel menu ⋯ dell'header; il primario va nel footer.

**Entrambe:**
- titolo del modale in sentence case con `--text-title`;
- stessa riga chiave/valore in item viewer, outfit viewer e Settings;
- stesso spazio tra le sezioni.

**Ambito:** item viewer (15–24), outfit viewer (25–27), Settings (10–14), piece picker (28–31), ConfirmDialog.

**File:** `item-editor.jsx`, `item-sheet.js`, `outfits.jsx`, `settings-modal.*`, `google-drive-storage.css`, `components/PiecePicker.jsx` (non le tile, che sono di S2), `ConfirmDialog.jsx`, `confirm-dialog.css`, `PanelActions.jsx`, `ModelPhotoControls.jsx`, `ModeledHero.jsx`, la sezione viewer di `styles.css`.

### S5: popover e flussi

**Problemi:**
- Il popover di import, il popover Mirror e l'importer Inspo hanno un linguaggio visivo diverso da quello dei modali.
- Il wizard di onboarding ha gerarchie e bottoni suoi.

**Comando impeccable:** `polish` + `onboard` (solo per il wizard).

**Variante A, "popover allineati":**
- Restano popover ancorati alla barra in alto.
- Adottano superficie, header, tipografia, chip e footer dei modali.

**Variante B, "tutto è un pannello":**
- Su desktop import, Mirror e importer Inspo diventano pannelli `ViewerPanel`: lo stesso side sheet dell'item viewer.
- Su telefono sono già sheet.

**Entrambe:** il wizard usa lo stesso header e footer dei modali, uno step indicator coerente e un solo primario per step.

**Ambito:** 51–62.

**File:** `import-flow.*`, `mirror.*`, `inspo.jsx` (solo l'importer), `onboarding.*`.

## Revisione (dopo ogni step della wave 1)

Per ogni step un revisore indipendente, Opus 5.5 high, con la skill impeccable e l'agente `impeccable-finish-reviewer` come riferimento. Riceve codice, obiettivi e screenshot, non le conclusioni del fixer.

Deve verificare:
- che la ridondanza o l'incoerenza sia risolta davvero, sugli stessi stati, a entrambe le larghezze;
- che palette e stile glass siano intatti;
- che non ci siano regressioni;
- che i confini dei file siano rispettati;
- che test e build passino.

Scrive `_shots/<nome>/REVIEW.md` con il verdetto PASS / PASS CON RISERVE / FAIL. Se ci sono riserve, si fa un giro di correzione dal fixer e una ri-verifica.

## Gate: scelta dell'utente

Dall'hub su http://127.0.0.1:5300 (tab "Round 2") l'utente sceglie A, B o nessuna per ognuno dei 5 step.

## Wave 2: dopo la scelta (sequenziale)

1. **Merge dei vincitori** in `ui/impeccable`, uno step alla volta, risolvendo i conflitti. Poi tour completo.
2. **S6, propagazione** ai modali di funzione che la wave 1 non ha toccato: color profile (34–37), declutter (38–40), suggestions (32–33), cheat sheet viewer/editor (41–47), pin Inspo e wishlist (48–50). Usa i pattern vincenti di S2, S3 e S4.
3. **S7, rifinitura finale:**
   - `impeccable adapt` sul telefono;
   - `impeccable polish` su tutto;
   - `impeccable audit` confrontato con l'audit dello step 0a, con l'obiettivo di zero P0/P1;
   - aggiornamento di `DESIGN.md`.
4. **Push** di `ui/impeccable` e apertura della PR verso `feat/desktop-app`, oppure verso `main` se l'utente preferisce.
