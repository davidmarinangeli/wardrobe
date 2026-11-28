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

**Esito dello step 0a.** `PRODUCT.md`, `DESIGN.md` e `.impeccable/design.json` alla radice del repo; `docs/impeccable/audit.md` (problemi per pagina con gravità e step, top 10, verifica del diff visivo); `docs/impeccable/components.md` (inventario per famiglia, forma canonica, valori orfani). Il consolidamento ha sostituito 409 spaziature e 2 radius con i token esistenti, senza differenze visive. L'audit ha corretto alcuni assunti di questo piano: le sezioni della wave 1 qui sotto sono già aggiornate, e la tabella "Proprietà dei file" è nuova.

### Step 0b: estensione dell'harness (1 agente, fuori dal repo, in parallelo a M e 0a)

- `variants.mjs` diventa a "round": ogni variante dichiara la propria `baseline`. Il round 1 resta confrontato con `before`; il round 2 con `impeccable-base`.
- L'hub mostra un tab per round. Ogni variante ha accanto A e B e la loro baseline: link live, galleria a coppie, NOTES.md e REVIEW.md, e la scelta "A / B / nessuna" salvata in localStorage ed esportabile.
- Registra le varianti e le porte della tabella sopra. Nessun worktree: li crea l'orchestratore.

## Wave 1: miglioramenti con varianti (5 agenti in parallelo)

Ogni step ha un file di proprietà. Si modificano solo quelli dichiarati, per poter unire liberamente qualunque combinazione di A e B. Se servono primitive condivise in `src/styles.css`, si scrivono solo dentro un blocco commentato `/* == S<n> ... == */` dello step.

Ogni step legge prima `docs/impeccable/audit.md` (i problemi con il suo codice di step) e `docs/impeccable/components.md` (le famiglie che tocca), e chiude i P1 e P2 che gli sono assegnati in entrambe le varianti, salvo dove la variante li risolve in modo diverso.

### Proprietà dei file (precisata dallo step 0a)

L'audit ha mostrato che diversi file servono a più step: `App.jsx`, `styles.css`, `item-editor.jsx` (contiene anche la card del Wardrobe), `outfits.jsx` (card e viewer), `inspo.jsx` (header, card, importer e viewer). Per questi la proprietà è per funzione o per gruppo di selettori, non per file. I numeri di riga sono quelli del commit dello step 0a e servono a trovare il punto.

| File | S1 | S2 | S3 | S4 | S5 |
| --- | --- | --- | --- | --- | --- |
| `App.jsx` | header delle pagine, barra in alto, `MobileHeadRow`/h1, azioni di pagina | definizione delle hot card (≈320-390: eyebrow, titolo, corpo) | il blocco `navExtra` col filtro "Matches my colors" (≈655-668) | — | — |
| `styles.css` | `.app-top-bar*`, `.app-view-switch*`, `.top-action*`, `.gallery-pane`, `.gallery-header`, `.mobile-headrow`/`.mobile-largetitle` (757-781), `.gallery-meta-row`, `.piece-count` e i loro override responsive | `.gallery-grid`, `.gallery-item*` (898-1065), `.gallery-item__peek-dots` (3360-3370) e override responsive | `.category-nav*` (803-895 e override a 860px), `.field*` (1939-1975), `.tag-editor`/`.editable-tag*`/`.tag-input-row` (2179-2231), `.detail-row__tag` (3104-3114), `.sheet-field*` (3245-3263) | sezione viewer: `.viewer*`, `.detail-row*` (salvo `__tag`), `.details-label`, `.item-*`, `.variant-*`, `.sheet-menu`/`.tier-menu`, `.save-bar*`, `.stage-*`, `.refine-composer*`, `.modeled-*` | `.popover-*` (402-470) |
| `item-editor.jsx` | — | `GalleryItem` (123-273) | — | tutto il resto | — |
| `outfits.jsx` | — | `OutfitCard`, `OutfitHoverPieces`, `OutfitFlatLay` e la griglia di `OutfitsSection` | — | `OutfitViewer`, `OutfitPicker` | — |
| `inspo.jsx` | `Inspo` (header, conteggio, Pieces/Sources) | `PinCard` (205-242) | — | — | `InspoImporter` (28-204) |
| `cheat-sheets.jsx` | — | `SheetCard` (75-91) | — | — | — |
| `overview-pieces.jsx` | — | il markup della card e del checkbox (≈235-260) | — | — | — |
| `overview.css` | tutto salvo la ricerca | `.overview-card*` (201-228, 294-346) | `.overview-search*` (56-92) | — | — |
| `outfits.css` | — | griglia e card (`.outfit-card*`) | `.outfit-style-tag*` | viewer (`.outfit-viewer*`) | — |
| `inspo.css` | — | griglia | `.inspo-tabs*` e `.inspo-url-field*` (33-104) | — | contenitore dell'importer e dropzone |
| `settings-modal.css` | — | — | `.settings-tab*` (13-48) | tutto il resto | — |
| `declutter.css` / `cheat-sheets.css` | — | griglia dei cheat sheet | soli tab (`.declutter-tabs*`, `.cheat-editor__mobile-tabs*`) | — | — |
| `components/piece-picker.css` | — | tile e checkbox | filtri (`.piece-picker__filters`, `__search`, `__chips`, 25-37) | resto | — |
| `onboarding.css` | — | — | — | — | tutto (anche `.provider-switch`, usato da Settings: S4 lo corregge solo con un override in `settings-modal.css`) |
| `main.jsx` | — | — | gli import di `chips.css` e `fields.css`, dopo `styles.css` e prima di `buttons.css` | — | — |

Regole che rendono combinabile qualunque A/B:
- **S3 non modifica JSX di S2, S4 o S5.** I nuovi `chips.css` e `fields.css` applicano la forma canonica anche alle classi esistenti con liste di selettori (per esempio `.field input, .sheet-field input, .import-field input, .onboarding-field input`), con specificità uguale o maggiore. Le regole duplicate si tolgono solo dai blocchi che S3 possiede (tabella sopra); i duplicati negli altri file restano e li toglie lo step proprietario in wave 2 o S6. Le sostituzioni di classe nei JSX S3 le fa solo in `App.jsx` (`navExtra`) e nei componenti che non sono di nessuno step della wave 1 (`declutter.jsx` per i tab, `cheat-sheets.jsx` per i soli tab telefono).
- **S1 non cambia i nomi di classe** `.category-nav`, `button.active`/`aria-pressed` e `.piece-count` (se lo tiene): può spostarli o toglierli dal layout, ma lo stile del chip è di S3.
- **Testi.** La grafia "colours/colors" è mista (`audit.md`, problema trasversale 7). La decide l'utente al gate; fino ad allora nessuno step la cambia.

### S1: shell delle pagine e gerarchia (Wardrobe, Overview, Inspo, barra in alto, header e nav mobile)

**Problemi** (audit A01-A08):
- Overview mostra la posizione quattro volte su desktop (nav, h1, tab, h2 "Outfits 5") e cinque su telefono, dove si aggiungono la tab bar e, scorrendo, la pill flottante col nome della pagina (07-phone).
- Wardrobe e Inspo hanno ora un h1 su entrambe le larghezze (viene da `.mobile-headrow`, riusato su desktop in `styles.css:763-781`), più l'eyebrow-conteggio "20 PIECES" / "11 ITEMS" e la riga dei chip: tre righe di intestazione. Il vecchio assunto "Wardrobe su desktop non ha titolo" non vale più.
- Inspo mette la pill "SOURCES (5)" dentro la riga delle categorie, e il conteggio "11 ITEMS" somma pezzi e fonti senza cambiare tra le due viste.
- Le etichette della bottom nav sono a 2,0:1 e 1,5:1 sul vetro scuro (P1, WCAG 1.4.3).
- Su telefono i due bottoni flottanti più la bottom nav coprono la riga inferiore della griglia già al primo caricamento.
- Le tre pagine hanno un header diverso.

**Comando impeccable:** `layout` + `distill`.

**Variante A, "i tab sono il titolo":**
- Su desktop nessun h1 visibile, perché la nav dice già dove sei. L'h1 resta nel DOM con `.sr-only` (già globale), così vale la regola "un solo h1 per vista".
- I sotto-tab diventano l'intestazione della pagina: più grandi, con il conteggio ("Outfits 5"), sulla stessa riga delle azioni, allineate a destra.
- Nessun h2 di sezione.
- Wardrobe e Inspo: conteggio e filtri su una sola riga. In Inspo "Pieces / Sources" diventano due tab come in Overview, ognuno col proprio conteggio.

**Variante B, "titolo + segmented":**
- Un solo h1 per pagina con il nome del contenuto corrente ("Outfits"), il conteggio come caption.
- La sotto-navigazione è un segmented glass: lo stesso componente della nav in alto, in piccolo, accanto al titolo. Le azioni stanno a destra.
- Spariscono la barra dei tab e l'h2.
- Wardrobe ha "Wardrobe · 20"; Inspo ha "Inspo" con il segmented "Pieces / Sources", separato dalle categorie.

**Entrambe:**
- su telefono stessa logica, con `MobileHeader` coerente; la pill flottante col nome della pagina non ripete ciò che dice già la tab bar;
- un solo h1 per vista;
- azioni con al massimo un primario;
- contrasto delle etichette della bottom nav ≥4,5:1 senza nuovi colori: si agisce su opacità di `--glass-dark` (o sul suo uso nella sola nav), colore delle etichette tra i token esistenti e peso, e si verifica col detector (`impeccable detect --json http://127.0.0.1:<porta> --viewport 390x844`);
- il conteggio di Inspo descrive la vista corrente;
- i bottoni flottanti su telefono non coprono contenuto a riposo (spazio riservato sotto la griglia, o meno chrome).

**File:** vedi la tabella "Proprietà dei file". In sintesi: `App.jsx` (header delle pagine e barra in alto), `components/PageShell.jsx`, `MobileHeader.jsx`, `BottomNav.jsx`, `mobile-chrome.css`, `overview.jsx`, `overview.css` (salvo ricerca e card), `inspo.jsx` (solo `Inspo`), i selettori S1 di `styles.css`. Lo stile dei chip di categoria è di S3.

**Stati da controllare:** 01–09.

### S2: card e griglie

**Problemi** (audit B01-B08, `components.md` §1 e §12): le card dei capi (Wardrobe, Pieces, Inspo), degli outfit, dei cheat sheet, le hot card ("My colours", "Declutter") e le tile del picker hanno superfici, radius, padding, caption e badge diversi. Ne fanno parte i puntini del carosello sotto la card, che spostano la caption di 22px, e il badge "Retry" che esce dalla card. In più:
- su desktop le card degli outfit non mostrano il nome finché non ci si passa sopra (P1: con quattro flat lay simili non si riconosce nulla), su telefono sì;
- la caption usa tre pesi di titolo (13/500, 15/500, 15/600) e la meta in maiuscolo o in sentence case; il commento in `outfits.css` dice "card titles are --text-subsection everywhere" ma la card del Wardrobe usa `--text-body`;
- il picker scrive la categoria al plurale ("TOPS"), le altre card al singolare;
- l'eyebrow delle hot card fa da kicker sopra il titolo;
- copertina dei cheat sheet `#fff` letterale e un'ombra interna nera (`hot-cards.css:132`).

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
- il checkbox di selezione è identico in Pieces e nel picker;
- il nome dell'outfit è sempre visibile su desktop come su telefono;
- una sola regola per caso e peso della caption, e la categoria al singolare ovunque;
- niente kicker sopra il titolo della hot card (il nome della funzione diventa il titolo, o una riga sotto).

**File:** vedi la tabella "Proprietà dei file". In sintesi: i selettori S2 di `styles.css`, `components/hot-cards.css`, `HotCards.jsx`, `OutfitStack.jsx`, i componenti card dentro `item-editor.jsx` (`GalleryItem`), `outfits.jsx` (`OutfitCard` e griglia), `inspo.jsx` (`PinCard`), `cheat-sheets.jsx` (`SheetCard`), `overview-pieces.jsx` (markup della card), le definizioni delle hot card in `App.jsx`, `piece-picker.css` (solo tile e checkbox), `outfits.css`, `cheat-sheets.css`, `inspo.css` e `overview.css` (solo griglia e card), `wishlist.css`.

**Stati da controllare:** 01–09, 28, 31, 46.

### S3: filtri, chip e controlli

**Problemi:**
- Le pill delle categorie sono tutte maiuscole e la riga è lunghissima su desktop.
- "MATCHES MY COLORS" è un filtro di natura diversa, ma ha lo stesso aspetto delle categorie.
- I chip dei tag e degli stili hanno ognuno uno stile diverso: "cotton" nel viewer, "CASUAL" nell'outfit.
- I tab sono cinque implementazioni, non tre (audit C01): Overview (sottolineato `--accent`), Settings (sottolineato `--ink`), importer Inspo (maiuscolo a tutta larghezza, `--accent-warm`, e `:focus-visible` senza outline), Declutter e cheat editor su telefono (segmented). In Settings sotto i tab ci sono due filetti.
- Il campo di ricerca e gli input non hanno un aspetto unico; il focus è di tre tipi e quello della ricerca Overview non viene disegnato (`overview.css:72`, valore non valido).
- Le card di scelta "uno tra N" (provider in Settings e nel wizard, metodo "Describe it / Use a photo", occasioni, risposte del quiz, copia Drive) hanno cinque stati selezionati diversi (audit C07, `components.md` §11): famiglia nuova, non prevista nella prima stesura.

**Comando impeccable:** `distill` + `typeset` (solo per le etichette dei controlli).

**Variante A, "chip leggeri":**
- Chip in sentence case, più bassi.
- Lo stato selezionato è pieno con `--ink`.
- Su tutte le larghezze la riga scorre orizzontalmente con una sfumatura ai bordi.
- "Matches my colors" diventa un toggle separato da un divisore.

**Variante B, "track glass":**
- Le categorie stanno in una sola traccia glass a scorrimento, come un segmented lungo, con lo stesso linguaggio della nav in alto.
- Il filtro trasversale "Matches my colors" va in un bottone "Filter" con un menu. "Sources" non è di S3: lo toglie dalla riga dei chip S1, in entrambe le sue varianti.

**Entrambe:**
- un solo stile di chip per i tag (read-only ed editabile), in sentence case: i tag del capo ("cotton") e gli style tag dell'outfit ("CASUAL") diventano uguali;
- un solo stile di campo per testo, ricerca e select, con un solo focus (bordo `--accent-warm` + `--ring-focus`); corretto il focus della ricerca Overview;
- i tab dentro i modali (Settings, Declutter, Inspo importer, cheat editor su telefono) sono un solo componente, con outline al focus; il filetto dei tab è l'unico divisore sotto l'header (in Settings il secondo filetto viene da `.provider-switch` in `onboarding.css`: lo neutralizza S4 con un override, S3 non tocca `onboarding.css`);
- una `.choice` (card di scelta) definita in `fields.css` con un solo stato selezionato, applicata con selettori alias alle classi esistenti dove S3 può (le altre le aggancia S6);
- bersagli dei tab e dei toggle almeno 44px su telefono.

**File:** `src/components/chips.css` (nuovo) e `src/components/fields.css` (nuovo), importati in `main.jsx`; i selettori S3 della tabella "Proprietà dei file" (chip di categoria, campi e tag in `styles.css`, tab in `settings-modal.css`, `inspo.css`, `declutter.css`, `cheat-sheets.css`, filtri del picker, ricerca di Overview); in JSX solo `App.jsx` (`navExtra`), `declutter.jsx` e `cheat-sheets.jsx` (soli tab). Non si tocca la struttura degli header, che è di S1, né il JSX di S2, S4 e S5.

**Stati da controllare:** 01, 03, 06, 08–14, 19, 25, 35, 39, 51.

### S4: contenuto dei modali principali

**Problemi** (audit D01-D08):
- I titoli dei modali sono già in sentence case e in `--text-title` dopo il primo giro (Settings, item e outfit viewer: 10, 15, 25): questo punto della prima stesura è chiuso. Resta il kicker sopra il titolo nelle conferme ("UNSAVED CHANGES", "DELETE SHEET": 44, 45) e nel pannello di selezione bulk ("OVERVIEW", `overview-pieces.jsx:271`, se S4 lo prende; altrimenti S6).
- Le etichette di sezione sono di tre tipi e il conteggio ha tre formati: eyebrow "CATEGORY", "3 PIECES", "WAYS TO WEAR IT · 3", "OUTFITS · 1".
- Ogni modale ha le sue righe chiave/valore.
- La posizione delle azioni cambia: Delete/Edit/Wore it nel footer dell'outfit e menu ⋯ nel capo (P1).
- Settings › Cloud backup chiama la stessa funzione in tre modi: tab "Cloud backup", eyebrow "ARCHIVE", titolo "Google Drive isn't configured" (12); il wizard dice "Archive / Google Drive".
- `ConfirmDialog` ha superficie `--paper-raised` e radius `--r-lg`, diversi dal pannello.
- Sotto i tab di Settings ci sono due filetti (`.provider-switch { border-top }` in `onboarding.css:538`).

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
- titolo del modale in sentence case con `--text-title`, senza eyebrow sopra (anche nelle conferme);
- stessa riga chiave/valore in item viewer, outfit viewer e Settings;
- un solo formato per il conteggio nelle etichette di sezione;
- stesso spazio tra le sezioni;
- un nome solo per l'archivio in Settings (tab, titolo, testo), allineato a quello del wizard: la parola la propone S4 nelle NOTES, la conferma l'utente al gate;
- `ConfirmDialog` con la superficie e il radius del pannello;
- in Settings un solo filetto sotto i tab, con un override in `settings-modal.css` (non in `onboarding.css`, che è di S5).

**Ambito:** item viewer (15–24), outfit viewer (25–27), Settings (10–14), piece picker (28–31), ConfirmDialog.

**File:** vedi la tabella "Proprietà dei file". In sintesi: `item-editor.jsx` (salvo `GalleryItem`), `item-sheet.js`, `outfits.jsx` (`OutfitViewer`, `OutfitPicker`), `settings-modal.jsx`, `settings-modal.css` (salvo i tab), `google-drive-storage.*`, `components/PiecePicker.jsx` (non le tile, che sono di S2), `ConfirmDialog.jsx`, `confirm-dialog.css`, `PanelActions.jsx`, `ModelPhotoControls.jsx`, `ModeledHero.jsx`, `outfits.css` (solo viewer), i selettori S4 di `styles.css`.

### S5: popover e flussi

**Problemi** (audit E01-E06):
- Il popover di import, il popover Mirror e l'importer Inspo hanno un linguaggio visivo diverso da quello dei modali: kicker sopra il titolo ("WARDROBE IMPORT", "AI MIRROR"), icona nel titolo, e nell'import tre stati detti insieme ("2 ready for review", "Import needs attention", "3 items").
- Il wizard di onboarding ha gerarchie e bottoni suoi, e dice due cose sul progresso: cinque trattini (contano anche welcome e done) e l'eyebrow "Step 1 of 3" (P1). Ogni step ha anche un kicker ("SETUP", "STEP 2 OF 3", "ALL SET") e la scorciatoia "Archive settings" in un riquadro sopra il titolo.
- Quattro dropzone con quattro implementazioni (import, Inspo, Mirror, wizard).

**Comando impeccable:** `polish` + `onboard` (solo per il wizard).

**Variante A, "popover allineati":**
- Restano popover ancorati alla barra in alto.
- Adottano superficie, header, tipografia, chip e footer dei modali.

**Variante B, "tutto è un pannello":**
- Su desktop import, Mirror e importer Inspo diventano pannelli `ViewerPanel`: lo stesso side sheet dell'item viewer.
- Su telefono sono già sheet.

**Entrambe:**
- il wizard usa lo stesso header e footer dei modali, un solo indicatore di passo (trattini e testo contano la stessa cosa) e un solo primario per step;
- nessun kicker sopra i titoli di popover e step; il contesto, se serve, va nel sottotitolo;
- la scorciatoia all'archivio del wizard non sta sopra il titolo (footer o riga secondaria);
- una sola dropzone per import, Inspo, Mirror e wizard;
- i tab dell'importer Inspo prendono il componente tab di S3: S5 non li ristila (`inspo.css:33-104` è di S3), sistema solo il contenitore.

**Ambito:** 51–62.

**File:** `import-flow.*`, `mirror.*`, `inspo.jsx` (solo `InspoImporter`), `inspo.css` (contenitore dell'importer e dropzone), `onboarding.*`, i selettori `.popover-*` di `styles.css`. Il primario disabilitato che appare rosa (opacità .45 dell'oxblood, 51 e 60) è di `buttons.css`, condiviso: va in S7.

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
2. **S6, propagazione** ai modali di funzione che la wave 1 non ha toccato: color profile (34–37), declutter (38–40), suggestions (32–33), cheat sheet viewer/editor (41–47), pin Inspo e wishlist (48–50). Usa i pattern vincenti di S2, S3 e S4. In più (audit F01-F05): la card di scelta di S3 applicata a quiz, stagioni e copia Drive; i kicker rimasti ("ORIGINAL", "COLLECTION", "WHAT YOUR INSPO BOARD SAYS", "OVERVIEW" del pannello bulk se S4 non l'ha preso); i duplicati di stile che S3 ha lasciato nei file degli altri step; i riquadri interni (memo, avvisi, guide) ridotti a un solo `.inset` (`components.md` §10).
3. **S7, rifinitura finale:**
   - `impeccable adapt` sul telefono;
   - `impeccable polish` su tutto;
   - `impeccable audit` confrontato con l'audit dello step 0a, con l'obiettivo di zero P0/P1;
   - aggiornamento di `DESIGN.md`.
4. **Push** di `ui/impeccable` e apertura della PR verso `feat/desktop-app`, oppure verso `main` se l'utente preferisce.
