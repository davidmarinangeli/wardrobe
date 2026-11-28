# Audit di ridondanza e incoerenza (step 0a)

Base: `ui/impeccable` dopo il consolidamento dello step 0a (contenuto identico, a livello visivo, a 372b395). Prove: il tour completo in `wardrobe-variants/_shots/impeccable-base/` (62 stati, 1440×900 e 390×844; i nomi dei file sono citati tra parentesi senza estensione) e il codice (`file:riga`, `src/` sottinteso dove non indicato).

## Come è stato fatto

`⚠️ DEGRADED: single-context (delegated read-only run)`

- **Sostituzioni dichiarate.** L'agente dello step 0a è un subagente senza modo di fare domande all'utente. Per questo: l'intervista di `init` è stata sostituita da inferenze da README, AGENTS.md, `docs/` e codice, marcate "(da confermare)" in `PRODUCT.md`; la critique è stata eseguita nella modalità prevista dalla skill per le esecuzioni delegate (valutazione A in questo contesto con la rubrica, valutazione B = `impeccable detect --json` sui sorgenti e sull'URL a 1440×900 e 390×844, nessuno snapshot salvato in `.impeccable/critique/`, nessuna domanda finale). L'audit tecnico segue `reference/audit.md`; il report non è stato salvato con `audit-storage` perché il deliverable richiesto è questo file.
- **Modalità:** Operate. Vincoli dell'utente rispettati nelle raccomandazioni: palette, stile glass e radius restano; si raffina, non si sostituisce.
- `Questions skipped: delegated run`.

## Verifica del consolidamento (diff visivo)

- Tour prima (copia in `_runtime/impeccable-base-pre0a`, HEAD 372b395) e dopo (build del consolidamento) sugli stessi dati demo: 173 catture confrontate pixel per pixel (soglia 10/255 per canale).
- **161 catture identiche.** 12 differiscono per lo 0,0001-0,33% dei pixel; tutte in punti dove il colore dipende dal rendering non deterministico di `backdrop-filter` / rifrazione o dal ricampionamento delle immagini: la bottom nav dark glass (01-wardrobe-phone), i bottoni on-media "Refine photo" / "Generate model photo" / "Re-detect items" sopra la foto (25, 26, 48, 49 phone), singoli pixel sui cut-out (29, 30, 43) e l'ultima riga di pixel del viewport (42, 44 phone). Nessuno spostamento di geometria; maschere in `_runtime/impeccable-base-0a-diff/`.
- **`metrics.json`:** 0 differenze su 173 stati (rettangoli e stili calcolati di titoli e bottoni, dimensioni del testo).
- Esito: **nessun cambiamento visivo**.

## Punteggi

### Euristiche (Nielsen)

| # | Euristica | Punteggio | Problema principale |
| --- | --- | --- | --- |
| 1 | Visibilità dello stato del sistema | 3 | Import, job e generazioni sono ben segnalati; il conteggio di Inspo ("11 ITEMS") non cambia quando si passa a Sources (08, 09). |
| 2 | Corrispondenza col mondo reale | 3 | Linguaggio del dominio corretto; "Archive" / "Cloud backup" / "Google Drive" nominano la stessa cosa in tre modi (12, 58). |
| 3 | Controllo e libertà | 3 | Guardie sulle modifiche non salvate e conferme presenti; azioni dell'oggetto in posti diversi tra capo e outfit. |
| 4 | Coerenza e standard | 1 | Cinque tipi di tab, quattro stati "selezionato" per i chip, cinque card di scelta, tre superfici di card, tre focus dei campi, kicker sopra metà dei titoli dei modali. È il problema centrale. |
| 5 | Prevenzione degli errori | 3 | Conferme a due passi sui distruttivi; il wizard dice "Step 1 of 3" sopra cinque trattini (59). |
| 6 | Riconoscimento più che ricordo | 2 | Su desktop le card degli outfit non mostrano il nome finché non ci si passa sopra (04-overview-outfits-desktop). |
| 7 | Flessibilità ed efficienza | 3 | Tastiera, Escape, filtri e ricerca; nessuna scorciatoia per le azioni ripetute, accettabile. |
| 8 | Estetica e minimalismo | 2 | La posizione è ripetuta fino a quattro volte per vista; etichette in maiuscolo dappertutto. |
| 9 | Riconoscere e recuperare gli errori | 3 | Errori nominati con Retry (08, 54). |
| 10 | Aiuto e documentazione | 3 | Guide Do/Don't per le foto, descrizioni nei provider. |
| **Totale** | | **26/40** | **Buono, con un problema sistemico di coerenza** |

### Salute tecnica (audit)

| # | Dimensione | Punteggio | Rilievo principale |
| --- | --- | --- | --- |
| 1 | Accessibilità | 2 | Etichette della bottom nav a 2,0:1 sul vetro scuro (detector, 390×844); focus dei tab dell'importer Inspo ridotto a un cambio di colore (`inspo.css:72`); anello di focus della ricerca Overview non valido (`overview.css:72`). |
| 2 | Prestazioni | 4 | Budget di blur documentato e rispettato, niente blur sulle card di griglia, fallback reduced-motion e reduced-transparency. |
| 3 | Theming | 3 | Palette e scala tutte a token; restano `#fff` nelle copertine dei cheat sheet (`cheat-sheets.css:10`), un'ombra nera (`components/hot-cards.css:132`), `--danger` definito fuori da `:root` (`components/buttons.css:39`). Nessun dark mode, non richiesto. |
| 4 | Responsive | 3 | Layout telefono completo e curato; alcuni bersagli sotto 44px (tab di Overview 42px, "Wore it" 32px, tab di Settings 36px, toggle delle guide 32px: `metrics.json`), comunque sopra il minimo AA di 24px. |
| 5 | Integrità dell'implementazione | 2 | Sistema di token solido, ma i componenti sono duplicati per modulo (tab, chip, campi, card di scelta, dropzone, avvisi): vedi `components.md`. |
| **Totale** | | **14/20** | **Buono** |

### Carico cognitivo

Falliti 3 punti su 8 (carico moderato): gerarchia visiva (titoli ripetuti, kicker), scelte minime (12-13 chip di categoria in una riga su desktop, 01/08), coerenza dei pattern tra modali.

### Specificità del design

**Valutazione.** Il mondo visivo è riconoscibile e appartiene al prodotto: carta calda, vetro con il bordo illuminato, ombre di contatto sotto i cut-out, un solo oxblood. Il problema non è la genericità ma la frammentazione: ogni modulo (colour profile, declutter, onboarding, import, mirror) ha costruito la sua versione di tab, chip, riquadri e intestazioni, quindi l'app sembra cucita da più mani pur avendo un'unica palette.

**Detector.** `detect --json src`: 3 rilievi. *overused-font* su Instrument Sans (`styles.css:200`): falso positivo per questo giro, il font è parte del mondo esistente e non si cambia. *bounce-easing* su `--ease-spring` (`styles.css:195`): advisory, l'overshoot è lieve e usato solo nel deck delle suggestion, accettabile. *side-tab* su `.viewer.shake` in reduced-motion (`styles.css:2398`): vero, P3. URL a 1440×900: *cream-palette* (falso positivo: palette vincolata dall'utente). URL a 390×844: *cream-palette* più due *low-contrast* (2,0:1 e 1,5:1) sulle etichette della bottom nav: veri, P1.

## Problemi trasversali (sistemici)

1. **La posizione è detta troppe volte.** Overview › Outfits su desktop: pill "OVERVIEW" nella nav, h1 "Overview", tab "Outfits", h2 "Outfits 5" (04-overview-outfits-desktop). Su telefono la tab bar in basso dice di nuovo "OVERVIEW" e, scorrendo, compare una pill flottante "Overview" in alto (07-overview-pieces-selected-phone): fino a cinque livelli. Wardrobe e Inspo hanno ora un h1 (il piano diceva il contrario per Wardrobe) più un eyebrow-conteggio "20 PIECES" / "11 ITEMS" (01, 08).
2. **Kicker sopra i titoli.** "WARDROBE IMPORT" sopra "2 ready for review" (53), "AI MIRROR" sopra "How do I look?" (55), "COLLECTION" sopra "Edit cheat sheet" (42), "SETUP" / "STEP 1 OF 3" / "ALL SET" sopra i titoli del wizard (58-62), "ARCHIVE" sopra "Google Drive isn't configured" (12), "UNSAVED CHANGES" / "DELETE SHEET" sopra le conferme (44, 45), "OVERVIEW" sopra il pannello di selezione bulk (`overview-pieces.jsx:271`), "ORIGINAL" sopra il titolo del viewer dei cheat sheet (41), "MY COLOURS" / "DECLUTTER" sopra i titoli delle hot card (01). La skill lo vieta senza eccezioni (`craft-floor.md`, "A kicker or eyebrow above a heading").
3. **Card diverse per lo stesso ruolo.** Superficie glass, stage o bianco; radius 20 o 14; caption sotto, dentro, o dentro solo all'hover; titoli 13/500, 15/500, 15/600; meta in maiuscolo o no; puntini del carosello che spostano la caption; badge Retry fuori dalla card (01, 04, 05, 06, 08, 28). Dettaglio in `components.md` §1.
4. **Cinque tab, quattro chip, cinque card di scelta.** Overview (sottolineato accent), Settings (sottolineato ink), Inspo importer (maiuscolo a tutta larghezza, accent-warm), Declutter e cheat editor (segmented); chip selezionati come paper + ombra, pieni ink, anello accent o anello inset; provider, metodi, risposte del quiz, occasioni e copie Drive selezionati in cinque modi (10, 24, 32, 35, 51, 59). `components.md` §2-4, §11.
5. **Etichette e conteggi senza regola.** "WAYS TO WEAR IT · 3", "3 PIECES", "OUTFITS · 1", "Outfits 5", "Accessories 2 pieces", "6 pieces", "20 PIECES" (01, 04, 06, 15, 25). Tag in minuscolo nel capo ("cotton") e in maiuscolo nell'outfit ("CASUAL") (15, 25). Categoria singolare nelle card ("TOP") e plurale nel picker ("TOPS") (01, 28).
6. **Tre focus per i campi**, uno rotto: bordo + anello (`.field`), outline (`piece-picker.css:28`), anello non valido (`overview.css:72`).
7. **Ortografia mista "colours/colors"**: "My colours" (hot card, titolo del modale: `App.jsx:330`, `color-profile.jsx:867`) e "Matches my colors" (`App.jsx:665`), "Colors" nella riga del viewer (`item-editor.jsx:599`), "your colors" nel wizard (`onboarding.jsx:166`). Scegliere una variante (decisione dell'utente: il README usa "My Colors").

## Problemi per pagina e modale

Gravità: P0 blocca il compito; P1 difficoltà seria o violazione WCAG AA; P2 fastidio con alternativa; P3 rifinitura. Step: S1 shell delle pagine, S2 card, S3 controlli/chip/campi/tab, S4 contenuto dei modali principali, S5 popover e onboarding, S6 modali di funzione, S7 rifinitura.

Nessun P0.

### Shell, barra in alto e navigazione (01-09)

| ID | Gr. | Problema | Prova | Step |
| --- | --- | --- | --- | --- |
| A01 | P1 | Overview ripete la posizione quattro volte su desktop (nav, h1, tab, h2 con conteggio) e cinque su telefono (più tab bar e pill flottante). | 04-overview-outfits-desktop, 04-overview-outfits-phone, 07-overview-pieces-selected-phone; `overview.jsx:60`, `overview.css:16-18` | S1 |
| A02 | P1 | Etichette della bottom nav illeggibili sul vetro scuro: 2,0:1 per la scheda attiva e 1,5:1 per le altre (WCAG 1.4.3). Il vetro `--glass-dark` a .32 su carta crema diventa un grigio chiaro con testo crema sopra. | detector 390×844; 01-wardrobe-phone; `components/mobile-chrome.css:196` | S1 |
| A03 | P2 | Wardrobe e Inspo: h1 più eyebrow-conteggio "20 PIECES" / "11 ITEMS" più riga di chip: tre righe di intestazione prima del contenuto. L'assunto del piano ("Wardrobe su desktop non ha titolo") non è più vero: l'h1 viene da `.mobile-headrow` riusato su desktop (`styles.css:763-781`). | 01, 08 desktop; `components/PageShell.jsx:58`, `styles.css:793` | S1 |
| A04 | P2 | Inspo: "11 ITEMS" somma pezzi (6) e fonti (5) e resta uguale su entrambe le viste. | 08, 09; `inspo.jsx:478` | S1 |
| A05 | P2 | Inspo: la pill "SOURCES (5)" è un filtro categoria con un divisore, ma cambia il tipo di contenuto (pin invece di pezzi). | 08, 09; `styles.css:888` | S1 |
| A06 | P2 | Su telefono i due bottoni flottanti ("How do I look?", "Add clothes") più la bottom nav coprono la riga inferiore della griglia già al primo caricamento (caption tagliate). | 08-inspo-phone, 09-inspo-sources-phone | S1 |
| A07 | P3 | Due primari pieni a 200px di distanza (Add clothes nella barra e + Outfit / + Cheat sheet nell'header di sezione). Ammesso dalla regola di `buttons.css`, ma visivamente compete. | 04, 05 desktop | S1 |
| A08 | P3 | Overview › Pieces: la ricerca è una pill di 1328px a tutta larghezza; le sezioni hanno conteggio "2 pieces" accanto all'h2, mentre Outfits ha "5". | 06-overview-pieces-desktop | S1 (layout), S3 (campo) |

### Card e griglie (01-09, 28, 31, 46)

| ID | Gr. | Problema | Prova | Step |
| --- | --- | --- | --- | --- |
| B01 | P1 | Su desktop gli outfit non hanno nome a riposo: la caption appare solo all'hover. Con quattro flat lay simili l'utente deve passare sopra ogni card. Su telefono il nome c'è sempre. | 04-overview-outfits-desktop vs -phone; `outfits.css:322-335` | S2 |
| B02 | P1 | Tre superfici, due radius, tre posizioni della caption, tre pesi del titolo per lo stesso ruolo (oggetto in griglia). | 01, 04, 05, 06; `components.md` §1 | S2 |
| B03 | P2 | I puntini del carosello stanno tra arte e caption e abbassano di 22px la caption della prima card: la riga di caption non è allineata. | 01-wardrobe-desktop; `styles.css:3360` | S2 |
| B04 | P2 | Il badge "Retry" sta fuori dall'arte, accanto al nome. | 08-inspo-desktop; `wishlist.css:5` | S2 |
| B05 | P2 | Checkbox quadrato in Pieces, cerchio nel picker. | 06, 28; `overview.css:224`, `components/piece-picker.css:81` | S2 |
| B06 | P3 | Categoria singolare nelle card ("TOP"), plurale nel picker ("TOPS"). | 01, 28 | S2 |
| B07 | P3 | Copertina dei cheat sheet `#fff` letterale e senza ombra; ombra interna nera in `hot-cards.css:132`. | 05; `cheat-sheets.css:10` | S2 |
| B08 | P3 | Hot card: l'eyebrow "MY COLOURS" / "DECLUTTER" fa da kicker sopra il titolo. | 01-wardrobe-desktop; `App.jsx:330-384`, `components/hot-cards.css:99` | S2 |

### Controlli: chip, campi, tab (01, 03, 06, 08-14, 19, 25, 35, 39, 51)

| ID | Gr. | Problema | Prova | Step |
| --- | --- | --- | --- | --- |
| C01 | P1 | Cinque implementazioni di tab con tre colori della barra attiva, due casse e due forme (sottolineato / segmented). | 04, 10, 39, 42-phone, 51; `components.md` §3 | S3 |
| C02 | P2 | Chip di categoria in maiuscolo (13 in una riga su desktop), chip del picker in sentence case con stato attivo pieno ink: stesso compito, due linguaggi. | 01, 08, 28 | S3 |
| C03 | P2 | "MATCHES MY COLORS" ha l'aspetto di una categoria ma è un filtro trasversale combinabile. | 01-wardrobe-desktop; `App.jsx:655-668` | S3 |
| C04 | P2 | Tag del capo in minuscolo con bordo glass, style tag dell'outfit in maiuscolo senza bordo. | 15, 25; `styles.css:3104`, `outfits.css:265` | S3 |
| C05 | P2 | Focus dei campi in tre modi; quello della ricerca Overview non viene disegnato (valore `box-shadow` non valido). | 06, 28; `overview.css:72`, `components/piece-picker.css:28` | S3 |
| C06 | P2 | Tab dell'importer Inspo: `:focus-visible` toglie l'outline e lascia solo un cambio di colore (WCAG 2.4.7 al limite). | 51; `inspo.css:72` | S3 |
| C07 | P2 | Cinque card di scelta con cinque stati selezionati (bordo ink, anello inset accent-warm, anello accent, pieno accent). | 10, 24, 32, 35, 59; `components.md` §11 | S3 (componente), S6 (propagazione) |
| C08 | P3 | Settings: sotto i tab ci sono due filetti a 26px di distanza (la barra dei tab più `border-top` di `.provider-switch`). | 10-settings-ai-desktop, 10-settings-ai-phone; `onboarding.css:538` | S3 (tab) con override in `settings-modal.css` |
| C09 | P3 | Bersagli sotto 44px su telefono: tab di Overview 42px, tab di Settings 36px, toggle delle guide 32px. | `metrics.json` (04, 10 phone) | S3 |

### Modali principali: item viewer, outfit viewer, Settings, picker, conferme (10-31, 44-45)

| ID | Gr. | Problema | Prova | Step |
| --- | --- | --- | --- | --- |
| D01 | P1 | Le azioni dell'oggetto stanno in posti diversi: menu ⋯ nel capo (Regenerate, Delete), footer con Delete / Edit / Wore it today nell'outfit. | 15, 17, 25 | S4 |
| D02 | P2 | Etichette di sezione con tre formati di conteggio ("WAYS TO WEAR IT · 3", "3 PIECES", "OUTFITS · 1"). | 15, 25; `styles.css:1633` | S4 |
| D03 | P2 | Righe chiave/valore solo nell'item viewer; outfit viewer e Settings le risolvono in altro modo. | 15, 25, 10, 14 | S4 |
| D04 | P2 | Settings › Cloud backup: tab "Cloud backup", eyebrow "ARCHIVE", titolo "Google Drive isn't configured": tre nomi per la stessa funzione; il wizard dice "Archive / Google Drive". | 12, 58; `settings-modal.jsx:122` | S4 (testi) |
| D05 | P2 | Conferme con eyebrow sopra il titolo ("UNSAVED CHANGES", "DELETE SHEET"), superficie `--paper-raised` e radius `--r-lg` invece di quelli del pannello. | 44, 45; `components/confirm-dialog.css:4-5` | S4 |
| D06 | P3 | Item viewer su telefono: i tag della riga TAGS vanno a capo su due righe, quindi la riga è più alta delle altre e l'etichetta resta centrata in verticale invece che allineata alla prima riga di tag. | 15-item-viewer-scrolled-phone | S4 |
| D07 | P3 | Reduced motion: la scossa del pannello diventa una barra laterale di 3px (pattern vietato). | `styles.css:2398` | S4 |
| D08 | P3 | Picker: la ricerca ha il focus a outline (doppio contorno arrotondato) diverso dagli altri campi del modale. | 28-outfit-picker-new-desktop | S3 |

### Popover e onboarding (51-62)

| ID | Gr. | Problema | Prova | Step |
| --- | --- | --- | --- | --- |
| E01 | P1 | Wizard: cinque trattini di avanzamento e l'eyebrow "Step 1 of 3" / "Step 2 of 3" dicono due cose diverse (i trattini contano anche welcome e done). | 59, 60; `onboarding.jsx:15`, `:114-119`, `:184`, `:325`, `:523` | S5 |
| E02 | P2 | Import e Mirror hanno un'intestazione propria (eyebrow + icona + titolo) diversa da quella dei pannelli; l'import dice insieme "2 ready for review", "Import needs attention" e "3 items". | 53, 55, 57 | S5 |
| E03 | P2 | Wizard: la scorciatoia "Archive settings › Archive / Google Drive" è un riquadro sopra il titolo di ogni step e compete con esso. | 58-62 | S5 |
| E04 | P2 | Importer Inspo: tab maiuscoli a tutta larghezza diversi da Settings; il primario "Import" disabilitato appare rosa (opacità .45 dell'oxblood). | 51, 52 | S5 (con S3 per i tab) |
| E05 | P2 | Quattro dropzone con quattro implementazioni (import, Inspo, Mirror, wizard). | `import-flow.css:26`, `inspo.css:112`, `mirror.css:68`, `onboarding.css:286` | S5 |
| E06 | P3 | Wizard provider: oltre a Gemini selezionato, anche MiniMax ha il bordo scuro (focus o hover lasciato dal tour); due card sembrano selezionate. Da verificare a mano. | 59-onboarding-provider-desktop | S5 |

### Modali di funzione (32-50), fuori dalla wave 1

| ID | Gr. | Problema | Prova | Step |
| --- | --- | --- | --- | --- |
| F01 | P2 | Colour profile: sesso come segmented proprio, risposte del quiz piene accent, footer Cancel/Save proprio. | 34, 35 | S6 |
| F02 | P2 | Declutter: tab segmented e bottoni Keep / Sell / Donate impilati a tutta larghezza su telefono, unici nell'app. | 38, 39 | S6 |
| F03 | P2 | Suggestions: style memo con eyebrow e icona, occasioni come chip con anello inset, motivi come mini-tabella senza filetti. | 32, 33 | S6 |
| F04 | P2 | Cheat sheet viewer/editor: eyebrow "ORIGINAL" / "COLLECTION", tab telefono segmented, campo titolo con bordo accent sempre acceso. | 41, 42 | S6 |
| F05 | P3 | Pin viewer: footer Delete / Close dove gli altri viewer chiudono solo con la X. | 48 | S6 |

## Top 10

1. A01 (P1, S1) Overview ripete la posizione 4-5 volte.
2. A02 (P1, S1) Etichette della bottom nav a 2,0:1 e 1,5:1.
3. B01 (P1, S2) Nomi degli outfit visibili solo all'hover su desktop.
4. B02 (P1, S2) Card con superficie, radius, caption e titolo diversi per lo stesso ruolo.
5. C01 (P1, S3) Cinque implementazioni di tab.
6. D01 (P1, S4) Azioni dell'oggetto in posti diversi tra capo e outfit.
7. E01 (P1, S5) Wizard: cinque trattini contro "Step 1 of 3".
8. Kicker sopra i titoli in 10+ punti (sistemico 2; S4, S5, S2, S6).
9. C05 (P2, S3) Tre focus dei campi, uno non disegnato.
10. C07 (P2, S3/S6) Cinque card di scelta con cinque stati selezionati.

## Cosa resta bene

- Il sistema di token è già completo e quasi tutto usato: palette, radius, ombre, blur, scala tipografica, motion; dopo il consolidamento anche 409 spaziature.
- L'anatomia di `ViewerPanel` (header e footer fissi, un solo scroller, filetti solo quando serve) regge in tutti i viewer e nelle sheet su telefono (15, 25, 10-phone).
- Il vocabolario dei bottoni di `buttons.css` è coerente ovunque sia stato applicato (Delete outlined, Edit secondary, Wore it today primary in 25).
- Materiale e profondità sono specifici del prodotto e motivati nel codice (budget di blur, ombre calde, ombra di contatto sui cut-out), con fallback per reduced motion e reduced transparency.

## Raccomandazioni in ordine

1. **[P1] `/impeccable layout` + `distill`** (S1): un solo livello di titolo per vista, contrasto della bottom nav.
2. **[P1] `/impeccable polish` + `layout`** (S2): card unica con caption sempre visibile.
3. **[P1] `/impeccable distill`** (S3): un tab, un chip, un campo, una card di scelta.
4. **[P1] `/impeccable layout` + `clarify`** (S4): azioni dell'oggetto nello stesso posto, etichette senza kicker, un formato di conteggio.
5. **[P1] `/impeccable onboard` + `polish`** (S5): indicatore di passo unico, intestazioni dei popover come i pannelli.
6. **[P2] `/impeccable polish`** (S6, S7): propagazione ai modali di funzione, poi audit di confronto.
