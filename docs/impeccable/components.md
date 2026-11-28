# Inventario dei componenti

Step 0a del piano (`docs/impeccable/plan.md`), su `ui/impeccable` dopo il consolidamento. Per ogni famiglia: le varianti che esistono oggi (file:riga e classi), cosa le distingue, e la forma canonica proposta. La forma canonica è una proposta: dove il piano prevede le varianti A/B, la scelta finale la fa l'utente al gate, e qui si indica solo cosa devono avere in comune.

I numeri di riga si riferiscono al commit dello step 0a. Le prove visive sono in `wardrobe-variants/_shots/impeccable-base/` (nome file tra parentesi).

## Indice

1. Card
2. Chip e pill
3. Tab
4. Segmented control
5. Campi, ricerca e select
6. Righe chiave/valore
7. Etichette di sezione (eyebrow)
8. Badge e stati
9. Menu
10. Pannelli e riquadri interni
11. Card di scelta (radio card): famiglia non prevista dal piano
12. Checkbox di selezione
13. Valori orfani

---

## 1. Card

| Variante | Dove | Superficie | Radius | Bordo / ombra | Caption |
| --- | --- | --- | --- | --- | --- |
| Garment (Wardrobe, Inspo, Wishlist) | `styles.css:910` `.gallery-item`, `:925` `.gallery-item__art`, `:1000` `__label`, `:1008` `__name`, `:1019` `__type`, `:1030` `__outfits` | `--glass-card` | `--r-lg` | `--glass-border`, `--glass-edge` + `--shadow-sm` | fuori, sotto: nome `--text-body` 500, tipo in eyebrow maiuscolo, "in N looks" in `--accent-warm` |
| Garment in Overview › Pieces | `overview.css:201` `.overview-card`, `:344-346` override di nome e tipo | come sopra | come sopra | selezionata: anello `--accent-warm` (`overview.css:207`) | come sopra |
| Picker tile | `components/piece-picker.css:57` `.piece-picker__card`, `:68` arte, `:99` `__label` | `--glass-card` | `--r-sm`/`--r-md` (vedi file) | selezionata: anello `--accent-warm` + `--shadow-sm` (`:98`) | fuori, sotto: tipo al **plurale** ("TOPS") mentre le altre card usano il singolare ("TOP") (28-outfit-picker-new-desktop) |
| Outfit | `outfits.css:60` `.outfit-card`, `:80` `.outfit-card-art`, `:285` `.outfit-card-caption`, `:298` `.outfit-card-name` | `--surface-stage` | `--r-lg` | `--line`, `--glass-edge` + `--shadow-sm` | **dentro** l'arte su una sfumatura paper; su desktop compare solo all'hover (04-overview-outfits-desktop non mostra nessun nome), su telefono sempre (04-overview-outfits-phone) |
| Cheat sheet | `cheat-sheets.css:4` `.cheat-card`, `:10` `__cover`, `:12` `__title`, `:13` `__meta` | `#fff` (letterale, fuori palette) | `--r-md` | `--line`, nessuna ombra | fuori: titolo `--text-subsection` **600**, meta in sentence case "6 pieces" (05-overview-cheat-sheets-desktop) |
| Hot card | `components/hot-cards.css:37` `.hot-card`, `:99` `__eyebrow`, `:107` `__title`, `:114` `__desc` | `--glass-card` | `--r-lg` | `--glass-edge` + ombra | dentro: eyebrow + titolo + descrizione + freccia |
| Item outfits (mini card nel viewer) | `styles.css:1660` `.item-outfits__card` | `--surface-stage` | piccola | — | sotto, caption |
| Variant tile ("Ways to wear it") | `styles.css:2992` `.variant-strip__tile`, `:3029` attiva | `--surface-stage` (`:3018`) | `--r-sm` | attiva: anello `--accent-warm` | sotto, centrata |
| Import card | `import-flow.css:143` `.import-card` | `--glass-card` | — | — | dentro, riga |
| Declutter card | `declutter.css:178` `.declutter-card`, `:186` arte | `--surface-stage` | — | — | sotto, centrata |
| Deck card (suggestions) | `suggestions.css:141` `.deck-card` | glass | — | trascinata: `--shadow-lg` | dentro |
| Mirror issue card | `mirror.css:219` `.mirror-issue-card` | `--glass-card` | — | — | dentro |
| Certified season card | `color-profile.css:869` `.certified-card` | — | — | hover `--accent-warm` + `--shadow-md` | dentro |

**Divergenze principali.** Tre superfici diverse per lo stesso ruolo "oggetto in griglia" (glass-card, surface-stage, bianco puro); due radius (`--r-lg` contro `--r-md`); tre posizioni della caption (sotto, dentro sempre, dentro solo all'hover); tre pesi del titolo (500 a 13px, 500 a 15px, 600 a 15px); la meta in maiuscolo o in sentence case; i puntini del carosello (`styles.css:3360` `.gallery-item__peek-dots`) stanno tra arte e caption e spostano la caption della prima card di 22px (01-wardrobe-desktop); il badge Retry (`wishlist.css:5`) sta fuori dall'arte, accanto alla caption (08-inspo-desktop). Il commento in `outfits.css` dice "card titles are --text-subsection everywhere", ma `.gallery-item__name` è `--text-body`.

**Forma canonica proposta (S2).** Una classe base `.card` con arte e caption, e modificatori dichiarati: `--garment`, `--outfit`, `--sheet`, `--hot`, `--tile`. In comune: radius `--r-lg` (`--r-sm` solo per le tile piccole del picker e del viewer), bordo `--glass-border` + `--glass-edge` + `--shadow-sm`, hover `translateY(-3px)` + `--shadow-md`, selezione = anello 1px `--accent-warm`, focus = outline `--accent-warm` 2px. Caption: titolo `--text-body` 500 (o `--text-subsection` 500, una sola scelta per tutte), meta in caption con la stessa regola di maiuscolo per tutte, altezza fissa. La superficie dell'arte resta di due tipi soltanto: `--glass-card` per i cut-out e `--surface-stage` per foto e flat lay; il bianco dei cheat sheet resta solo dentro la copertina (è il contenuto, non la card). Varianti A/B come da piano.

## 2. Chip e pill

| Variante | Dove | Aspetto | Usato in |
| --- | --- | --- | --- |
| Filtro categoria | `styles.css:824` `.category-nav button`, `:849` `.active` | pill 38px, `--wash-1`, eyebrow maiuscolo, attiva = paper raised + `--shadow-sm` | Wardrobe, Inspo (01, 03, 08) |
| Filtro colore | `styles.css:856` `.color-filter-btn`, `:869` attivo | come sopra + pallino stagione; attivo = anello `--accent` | Wardrobe "MATCHES MY COLORS" |
| Chip del picker | `components/piece-picker.css:31` `.piece-picker__chip`, `:32` `.is-active`, `:33` conteggio | pill 44px, paper raised + `--line`, sentence case, attiva = piena `--ink` | piece picker, nuovo cheat sheet (28, 46) |
| Tag in sola lettura | `styles.css:3104` `.detail-row__tag` | pill 26px, `--glass-border` + `--wash-1`, caption, minuscolo | item viewer (15) |
| Tag editabile | `styles.css:2189` `.editable-tag` | pill, `--glass-border` + `--wash-1`, caption, con × | item viewer in modifica |
| Style tag dell'outfit | `outfits.css:265` `.outfit-style-tag` | pill, `--wash-1`, **eyebrow maiuscolo** | outfit viewer (25: "CASUAL WEEKEND NAUTICAL") |
| Riga tag bulk | `overview.css:251` `.overview-tag-row` | riga con nome e rimuovi | Overview › Pieces selezionati (07) |
| Chip di stato sulla foto | `styles.css:2620` `.stage-chip` | bottone on-media | viewer (Refine photo, Re-detect items) |
| Occasioni | `suggestions.css:98` `.occasion-picker button`, `:118` attiva | pill con icona, attiva = anello inset `--accent-warm` | suggestions (32) |
| Pigmento / tessuto | `color-profile.css:106` `.color-pigment-chip`, `:678` `.drape-fabric-chip` | pill con pallino | colour profile (34, 36) |
| Pill "SOURCES (5)" | `inspo.jsx` (renderCategory) + `.category-nav__divider` `styles.css:888` | è un filtro categoria con conteggio, separato da un divisore | Inspo (08, 09) |

**Divergenze.** Quattro stati "selezionato" diversi (paper + ombra, pieno ink, anello accent, anello inset accent-warm); due casse (maiuscolo eyebrow e sentence case) per lo stesso tipo di filtro; tag in minuscolo nel capo e in maiuscolo nell'outfit; altezze 26 / 38 / 44px.

**Forma canonica proposta (S3).** Due componenti, non di più: `.chip` (filtro, selezionabile: una sola resa dello stato attivo, con `aria-pressed`) e `.tag` (etichetta, read-only o con ×). Sentence case per entrambi (il maiuscolo resta solo all'eyebrow), corpo `--text-body` per i chip e `--text-caption` per i tag, altezza 32px desktop / 44px telefono per i chip, `--r-full`. Il conteggio dentro il chip usa lo stile di `.piece-picker__chip-count`. Variante A/B come da piano per lo stato attivo e la riga di scorrimento.

## 3. Tab

| Variante | Dove | Aspetto | Prova |
| --- | --- | --- | --- |
| Overview subnav | `overview.css:33` `.overview-subnav`, `:41` button, `:52-53` attivo | sottolineati, gap 20px, attivo 600 + barra 2px `--accent` | 04-06 |
| Settings | `settings-modal.css:13` `.settings-tabs`, `:20` `.settings-tab`, `:37` attivo | sottolineati, padding 9×14, 600, attivo barra 2px `--ink` | 10-14 |
| Inspo importer | `inspo.css:33` `.inspo-tabs`, `:47` button, `:63` attivo | a tutta larghezza (flex 1), **eyebrow maiuscolo**, barra `--accent-warm`; `:72` il focus-visible toglie l'outline | 51-52 |
| Declutter | `declutter.css:12` `.declutter-tabs`, `:21`, `:37` | segmented pill su `--wash-1` | 38-39 |
| Cheat editor (telefono) | `cheat-sheets.css:140/166-168` `.cheat-editor__mobile-tabs` | segmented pill | 42-phone |
| Vista principale | `styles.css:323` `.app-view-switch`, `:721`, `:739` | segmented pill, eyebrow maiuscolo | barra in alto |
| Bottom nav | `components/BottomNav.jsx:75` `.bottom-nav`, `mobile-chrome.css` | dark glass, icona + etichetta maiuscola | tutte le pagine telefono |

**Divergenze.** Tre colori della barra attiva (accent, ink, accent-warm), due pesi, due casse, larghezza naturale o piena; Declutter e cheat editor usano un segmented per lo stesso compito che Overview e Settings risolvono con i sottolineati. In Settings la barra dei tab è seguita da un secondo filetto (`onboarding.css:538` `.provider-switch { border-top }`), quindi sotto i tab ci sono due linee a 26px di distanza (10-settings-ai-desktop, 10-settings-ai-phone).

**Forma canonica proposta (S3).** Un solo componente `.tabs` per i tab dentro i modali (Settings, Inspo importer, Declutter, cheat editor): sentence case, `--text-body` 500, attivo `--ink` 600 con barra 2px `--accent`, il filetto dei tab è il divisore dell'header (nessun altro filetto sotto). I tab di pagina (Overview) li decide S1 (A: diventano l'intestazione; B: segmented). Il segmented della navigazione principale è la famiglia 4.

## 4. Segmented control

| Variante | Dove | Note |
| --- | --- | --- |
| Vista principale | `styles.css:323`, `:721`, `:739` | traccia `--wash-1`, padding 3px, tab 34px maiuscoli, attivo paper raised + `--shadow-sm` |
| Declutter | `declutter.css:12-43` | stessa traccia, tab sentence case, attivo `--shadow-xs` |
| Cheat editor telefono | `cheat-sheets.css:166-168` | variante locale |
| Gemini TEST/PROD | `styles.css` `.ai-mode-switch__pill` (`:675`), `onboarding.jsx:50` | radiogroup in pill |
| Sesso (MAN/WOMAN) nel colour profile | `color-profile.css` (34-color-profile-desktop) | pill locale |

**Forma canonica proposta (S1/S3).** Un `.segmented` unico (traccia `--wash-1`, `--r-full`, padding 3px, opzione attiva paper raised + `--shadow-xs`, testo sentence case `--text-body`), con la taglia piccola per i modali. La nav principale può restare maiuscola solo se S1 decide così; se S1-B usa il segmented come sotto-navigazione, deve usare questo stesso componente.

## 5. Campi, ricerca e select

| Variante | Dove | Altezza / radius | Focus | Etichetta |
| --- | --- | --- | --- | --- |
| `.field` (input, select) | `styles.css:1939`, `:1956`, `:1971` | 42px, `--r-sm` | bordo `--accent-warm` + `--ring-focus` | eyebrow maiuscolo (`:1946`) |
| `.tag-input-row input` | `styles.css:1958`, `:2213` | come `.field` | come `.field` | — |
| `.sheet-field` | `styles.css:3245-3263` | 44px, `--r-sm` | come `.field` | eyebrow maiuscolo |
| Ricerca Overview | `overview.css:56` `.overview-search`, `:71` focus | 48px, **pill** con icona | bordo + `box-shadow: 0 0 0 3px var(--ring-focus)`: valore non valido (il token è già un'ombra completa), quindi l'anello non compare | — |
| Ricerca picker | `components/piece-picker.css:27-28` `.piece-picker__search` | 44px, `--r-sm`, senza icona | **outline** 2px `--accent-warm` offset 2px (28-outfit-picker-new-desktop) | — |
| Import editor | `import-flow.css:185-199` `.import-field` | 44px, `--r-sm` | proprio | **sentence case** ("Name", "Category") sotto un eyebrow "GARMENT IMAGE" (53) |
| Onboarding | `onboarding.css:239-270` `.onboarding-field` | proprio | proprio | caption sentence case |
| Inspo URL | `inspo.css:75-102` `.inspo-url-field` | textarea | `--ring-focus` | eyebrow |
| Cheat sheet titolo / descrizione | `cheat-sheets.css:37`, `:42` | proprio | proprio (bordo accent sempre visibile in 42) | caption sentence case |
| Refine composer | `styles.css:2925-2941` | proprio | `--ring-focus` | caption |
| Titolo editabile | `styles.css:1914` `.viewer-title-input` | inline | proprio | — |
| Select nella riga | `styles.css:3084` `.detail-row__select` | trasparente, riempie la riga | sulla riga | etichetta della riga |

**Divergenze.** Tre trattamenti del focus (bordo + anello, outline, anello rotto), due forme della ricerca (pill con icona, rettangolo senza icona), due casse delle etichette.

**Forma canonica proposta (S3).** `src/components/fields.css`: un `.input` (anche per select e textarea) 44px, `--r-sm`, paper raised, `--line`, focus = bordo `--accent-warm` + `--ring-focus`; un `.search` (stessa altezza, con icona e pulsante di cancellazione; forma pill o rettangolo da decidere una volta sola); un `.field-label` sopra il campo. Correggere il valore di `.overview-search:focus-within`.

## 6. Righe chiave/valore

| Variante | Dove | Note |
| --- | --- | --- |
| Item viewer | `styles.css:3050` `.detail-rows`, `:3052` `.detail-row` (griglia 92px / valore / 16px chevron), `:3073` `__label` eyebrow | 52px, filetto `--wash-2`, chevron che ruota |
| Settings, provider | `onboarding.css:553` `.provider-switch__option` | non è una riga chiave/valore ma una card di scelta (famiglia 11) |
| Settings, Drive account | `google-drive-storage.css:26` `.drive-account__card` | lista con icone, filetti interni |
| Suggestions, motivi | `suggestions.css` deck card ("Colour / Weather / Occasion") | chiave in grassetto a sinistra, testo a destra, senza filetti (33) |
| Outfit viewer | nessuna riga: descrizione + tag + pezzi | (25) |
| Pin viewer | `.field` con eyebrow ("CATEGORY", "NOTES") | campi, non righe (48) |
| Wishlist item | `.detail-row` (riuso) | (50) |

**Forma canonica proposta (S4).** `.detail-row` è già la forma migliore: chiave a sinistra (eyebrow o `--text-caption` muted, secondo la variante A/B di S4), valore `--text-body`, chevron solo se la riga apre qualcosa. Da riusare in outfit viewer (stile, pezzi, indossato), Settings (provider attivo, account Drive) e motivi delle suggestions (S6).

## 7. Etichette di sezione (eyebrow)

45 regole dichiarano `text-transform: uppercase`. Le etichette di sezione in particolare:

| Classe | Dove | Testo d'esempio | Ruolo |
| --- | --- | --- | --- |
| `.piece-count` | `styles.css:793` | "20 PIECES", "11 ITEMS" | conteggio sotto l'h1 |
| `.details-label` | `styles.css:1633` | "WAYS TO WEAR IT · 3", "OUTFITS · 1", "3 PIECES" | sezione del viewer: il conteggio sta a volte dopo (" · 3"), a volte prima ("3 PIECES") |
| `.detail-row__label` | `styles.css:3073` | "CATEGORY", "COLORS", "TAGS" | chiave della riga |
| `.field > span`, `.sheet-field > span` | `styles.css:1946`, `:3246` | "NAME", "DETAIL — optional" | etichetta campo |
| `.hot-card__eyebrow` | `components/hot-cards.css:99` | "MY COLOURS", "DECLUTTER" | sopra il titolo della hot card |
| `.popover-eyebrow`, `.mirror-popover__eyebrow` | `styles.css:454`, `mirror.css:62` | "AI MIRROR" | **sopra il titolo del modale** |
| `.import-popover__eyebrow` | `import-flow.css:115` | "WARDROBE IMPORT" | **sopra il titolo del modale** |
| `.onboarding-eyebrow` | `onboarding.css:99` | "SETUP", "STEP 1 OF 3", "ALL SET", "ARCHIVE" (anche in `settings-modal.jsx:122`) | **sopra il titolo dello step** |
| `.cheat-editor__eyebrow` | `cheat-sheets.css:2` | "COLLECTION" / "OVERVIEW" | **sopra il titolo del modale** |
| `.cheat-fullscreen__eyebrow` | `cheat-sheets.css:118` | "ORIGINAL" | sopra il titolo del viewer |
| `.confirm-dialog__eyebrow` | `components/confirm-dialog.css:5` | "UNSAVED CHANGES", "DELETE SHEET" | **sopra il titolo della conferma** |
| `.overview-selection__eyebrow` | `overview.css:243` | "OVERVIEW" | **sopra il titolo del pannello di selezione** |
| `.style-memo-label` | `suggestions.css:62` | "WHAT YOUR INSPO BOARD SAYS" | sezione |
| `.mirror-issue-fix-eyebrow`, `.mirror-verdict-label` | `mirror.css:290`, `:154` | "TRY INSTEAD", "4 THINGS TO ADJUST" | sezione |
| `.palette-candidates-label`, `.color-open-question-label` | `color-profile.css:247`, `:307` | "YOUR PALETTE", "STILL AN OPEN QUESTION" | sezione |
| `.variant-strip__label`, `.refine-composer__label`, `.sheet-menu__label` | `styles.css:2970`, `:2919`, `:2755` | | sezione / gruppo |

**Divergenze.** L'eyebrow fa tre lavori diversi (etichetta di campo, titolo di sezione, kicker sopra un titolo), e il terzo è vietato dalla skill (`reference/craft-floor.md`: "A kicker or eyebrow above a heading … is a ban"). Il conteggio nelle etichette ha tre formati ("Outfits 5" come h2 + numero, "WAYS TO WEAR IT · 3", "3 PIECES", "2 pieces" accanto all'h2 di Pieces).

**Forma canonica proposta (S4, S5, S1).** Eyebrow solo come etichetta di campo o chiave di riga (variante S4-A) oppure sostituito da titoli `--text-section` in sentence case (S4-B). In nessun caso sopra il titolo di un modale, di una conferma o di uno step: le informazioni che oggi porta (contesto, "step 2 di 4") vanno nel sottotitolo o nell'indicatore di passo. Un solo formato per il conteggio: "Titolo · N" (o "Titolo N" con il numero muted), uguale ovunque.

## 8. Badge e stati

| Variante | Dove | Aspetto |
| --- | --- | --- |
| "RECOMMENDED" | `onboarding.css:221` `.onboarding-badge` | pill piena `--accent`, eyebrow (59) |
| Do / Don't | `onboarding.css:439/459/463` `.photo-guide-badge` | pill colorata |
| Verdetto drape | `color-profile.css:714` `.drape-verdict-badge` | pill |
| TEST/PROD sul gear | `styles.css:655` `.setup-trigger__badge` | cerchio 15px con glifo 9px |
| Retry wishlist | `wishlist.css:5` `.wishlist-retry-badge` | bottone fuori dall'arte (08) |
| Stato foto | `styles.css:2600` `.stage-status`, `outfits.css:218` `.outfit-card-status`, `styles.css:3047` `.variant-strip__status` | banda o etichetta su foto |
| Stato import | `import-flow.css:124` `.import-status`, `:158` `.import-card__detail--status` | puntino + testo |
| Stato Drive | `google-drive-storage.css:44` `.drive-dot` | puntino con alone |
| Stato generico | `styles.css:1070` `.status`, `:1079` `.status.error` | testo |
| Mirror | `mirror.css:316` `.mirror-status`, `:145` `.mirror-verdict-dot` | puntino + testo |
| "In use" provider | Settings (10) | spunta verde + testo |
| "Wore it" sulla card outfit (telefono) | `outfits.css:20` `.outfit-worn-btn` | bottone pill on-media (04-phone) |

**Forma canonica proposta (S3 per il componente, S2 per la posizione sulle card).** Un `.badge` (pill `--text-caption` 500 sentence case, tre toni: neutro `--wash-2`, accent, success) e un `.status-dot` (8px + testo `--text-caption`) per gli stati di processo. Sulle card, badge e azioni di stato dentro l'arte in alto a destra (S2).

## 9. Menu

| Variante | Dove | Note |
| --- | --- | --- |
| Menu ⋯ del viewer | `styles.css:2731` `.sheet-menu`, `:2796` `__item`, `:2755` `__label`, `:2818` `__divider` | paper raised, `--line`, `--r-md`, `--shadow-lg`; etichette di gruppo "STANDARD", "ITEM" in maiuscolo (17) |
| Menu qualità (tier) | `styles.css:2744` `.tier-menu`, `:2765` `__option`, `:2785` `__price`, `:2787` `__foot` | stesso contenitore, ancorato sopra il bottone (23) |
| Select nativi | `.detail-row__select`, `.field select`, `import-field select` | menu del browser, non stilizzabili |

**Forma canonica.** Il menu è già un solo componente: resta così. Da allineare solo l'etichetta di gruppo (oggi `--text-eyebrow` senza tracking in `.tier-menu__title`, maiuscola in `.sheet-menu__label`) e da decidere se le azioni dell'outfit viewer entrano in questo menu (S4-B).

## 10. Pannelli e riquadri interni

| Variante | Dove | Aspetto |
| --- | --- | --- |
| Panel / sheet | `styles.css:1173` `.viewer`, `:1207` header, `:1340` body, `:1374` footer; `components/ViewerPanel.jsx` | opaco `--paper-warm`, `--r-xl`, `--glass-edge` + `--shadow-lg` |
| Confirm dialog | `components/confirm-dialog.css:4` | opaco `--paper-raised` (non `--paper-warm`), `--r-lg` (non `--r-xl`), padding 28px |
| Popover import | `import-flow.css` (`.import-popover`) | anatomia propria, eyebrow + icona + titolo |
| Popover Mirror | `mirror.css:24` `.mirror-popover` | anatomia propria, `--popover-pad` |
| Wizard | `onboarding.css`, `onboarding.jsx:758` | header con step dots, scorciatoia "Archive settings" in un riquadro |
| Style memo | `suggestions.css:51` `.style-memo` | `--glass-card`, etichetta eyebrow con icona |
| Domanda aperta | `color-profile.css:272` `.color-open-question` | riquadro cliccabile con CTA |
| Guide foto | `onboarding.css:349` `.photo-guide-card`, `:364` `.photo-guide-toggle` | riquadro richiudibile con fondo più scuro (10) |
| Dropzone | `inspo.css:112`, `mirror.css:68`, `onboarding.css:286`, `import-flow.css:26` | quattro dropzone con bordo tratteggiato, quattro implementazioni |
| Avvisi | `components/piece-picker.css:41` `.piece-picker__notice`, `styles.css:1759` `.unsaved-notice`, `:3350` `.variant-notice`, `:2633` `.stage-error`, `google-drive-storage.css:94` `.drive-offline-notice` | cinque riquadri d'avviso con padding e radius diversi (uno è il radius orfano 12px) |
| Account Drive | `google-drive-storage.css:26` `.drive-account__card` | riquadro con filetti |
| Selezione bulk | `overview.css:229` `.overview-selection--desktop` | pannello laterale con eyebrow "OVERVIEW" sopra l'h2 |

**Forma canonica proposta (S4/S5).** Tutto ciò che si apre sopra la pagina usa `ViewerPanel` (o il suo header/footer) e la superficie `--paper-warm` / `--r-xl`; la conferma resta un dialog piccolo ma con la stessa superficie e lo stesso radius. Dentro i modali un solo `.inset` (riquadro interno: `--r-md`, `--wash-1` o `--glass-card`, padding `--s-4`) per memo, avvisi, guide e domanda aperta, con un tono `--error` per gli avvisi; una sola `.dropzone`.

## 11. Card di scelta (radio card)

Non è nelle famiglie del piano, ma è il caso più incoerente dentro i modali: la stessa scelta "uno tra N" ha cinque aspetti.

| Variante | Dove | Selezionata |
| --- | --- | --- |
| Provider in Settings | `onboarding.css:553` `.provider-switch__option`, `:575` | bordo `--ink` + `--wash-1` (10) |
| Provider nel wizard | `onboarding.css:181` `.onboarding-provider`, `:199` | bordo `--ink` + `--wash-1` (59) |
| Metodo "Describe it / Use a photo" | `styles.css:1845` `.variant-method-picker button`, `:1871` | anello inset `--accent-warm` (24) |
| Copia da tenere (Drive) | `google-drive-storage.css:74`, `:78` | anello inset `--accent` |
| Risposte del quiz colori | `color-profile.css:456`, `:477` | **piena `--accent`** (35) |
| Occasioni | `suggestions.css:98`, `:118` | anello inset `--accent-warm` (32) |
| Stagione certificata | `color-profile.css:869` | hover `--accent-warm` |

**Forma canonica proposta (S3, poi S6).** Una `.choice` (radio card) con un solo stato selezionato: bordo `--accent-warm` + anello inset 1px dello stesso colore (il pattern più usato), testo invariato. Va in `src/components/fields.css` o in un `choices.css` di S3; S6 la propaga a quiz, Drive e stagioni.

## 12. Checkbox di selezione

| Variante | Dove | Forma |
| --- | --- | --- |
| Overview › Pieces | `overview.css:208` `.overview-card__select`, `:224` `.overview-card__check` | quadrato 20px `--r-xs`, bordo `--muted`, selezionato pieno (07) |
| Picker | `components/piece-picker.css:81` `.piece-picker__check`, `:97` | **cerchio** con bordo, selezionato pieno `--accent` (28) |

**Forma canonica (S2).** Una sola: il cerchio del picker è più leggibile sopra l'arte; la scelta è di S2.

---

## 13. Valori orfani

Valori rimasti letterali dopo il consolidamento dello step 0a perché **non coincidono** con un token. Non sono stati decisi: si elencano per gli step successivi (S1-S5 nei propri file, S7 per il resto). Per ciascuno: dove, valore, token più vicino.

### Cosa ha fatto il consolidamento

- 409 valori di spaziatura (`gap`, `row-gap`, `column-gap`, `padding*`, `margin*` e le proprietà custom di componente con `pad`/`gap` nel nome: `--btn-pad-x*`, `--popover-pad*`, `--viewer-pad-*`) uguali a `--s-1…--s-8` sono diventati il token, in 18 file. Esclusi: il blocco `:root` di `styles.css` (definizioni dei token) e `src/prototypes/`.
- 2 radius uguali a un token: `overview.css:224` `6px` → `var(--r-xs)`, `styles.css:3326` `14px` → `var(--r-md)`.
- Ombre e blur: nessuna sostituzione necessaria, erano già tutti token salvo gli orfani sotto.
- Diff visivo: nessuno (vedi `docs/impeccable/audit.md`, "Verifica del consolidamento").

### Radius

| Dove | Valore | Token più vicino | Nota |
| --- | --- | --- | --- |
| `styles.css:2640` (`.stage-error`) | `12px` | `--r-sm` (10) / `--r-md` (14) | riquadro d'errore sullo stage |
| `styles.css:2856` (`.refine-composer`, `--from-radius`) | `22px` | `--r-lg` (20) | raggio di partenza dell'animazione morph dal bottone: deve uguagliare il raggio del bottone a 44px, quindi probabilmente va lasciato o espresso come `calc(var(--btn-h-lg) / 2)` |
| `styles.css:3335` (`.variant-photo-upload__art img`) | `8px` | `--r-xs` (6) / `--r-sm` (10) | miniatura 34px |
| `styles.css:2169` (`.native-color` swatch) | `calc(var(--r-xs) - 2px)` | — | raggio interno derivato: corretto così |
| `settings-modal.css:40` | `var(--r-sm, 4px)` | — | il fallback `4px` non serve (il token esiste sempre) |
| 21 regole con `50%` | `50%` | `--r-full` | cerchi (pallini, avatar): `50%` è corretto per elementi quadrati, nessuna azione |

### Ombre

| Dove | Valore | Token più vicino | Nota |
| --- | --- | --- | --- |
| `styles.css:585-588` (`.top-action.ai-action:hover`) | `0 0 0 1px rgba(140,68,54,.18), 0 0 18px 1px rgba(140,68,54,.28)` | — | alone AI intenzionale (vedi `docs/design-references.md`, "glow reserved for the AI moments") |
| `styles.css:527` | `drop-shadow(0 0 2px rgba(255,255,255,.9)) drop-shadow(0 0 7px var(--accent-warm))` | — | bagliore del border beam AI, intenzionale |
| `components/hot-cards.css:132` | `inset 0 0 0 1px rgb(0 0 0 / 8%)` | `--wash-2` come colore | unico nero puro: dovrebbe essere `inset 0 0 0 1px var(--wash-2)` come in `color-profile.css:184` |
| `google-drive-storage.css:34` | `0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent)` | `--ring-focus` (forma) | alone di stato del pallino |
| `color-profile.css:384` | keyframe `0 0 0 0 … / 0 0 0 14px transparent` | — | pulsazione |
| `overview.css:72` | `0 0 0 3px var(--ring-focus)` | `--ring-focus` | **valore non valido** (il token è già un'ombra completa): l'anello non viene disegnato |
| `color-profile.css:124`, `:184`, `:258`, `:682`, `:905`; `styles.css:1873`, `:3029`, `:3101`; `suggestions.css:120`; `components/piece-picker.css:98`, `:147`; `google-drive-storage.css:78`; `overview.css:207` | `0 0 0 1px var(--…)` / `inset 0 0 0 1px var(--…)` | — | anelli di selezione e filetti interni fatti con l'ombra: già su token di colore, ma il pattern "anello di selezione" non ha un token proprio (candidato `--ring-select` negli step successivi) |
| `styles.css:2398` (`.viewer.shake`, reduced motion) | `inset 3px 0 0 var(--accent)` | — | barra laterale sul pannello: pattern vietato dalla skill ("a bar down one side of a rounded box"); segnalato dal detector |

### Blur

| Dove | Valore | Token più vicino | Nota |
| --- | --- | --- | --- |
| `styles.css:419` | `filter: blur(4px)` | `--glass-blur-scrim` (3px) | entrata animata della chip, non un vetro |
| `mirror.css:49` | `filter: blur(6px)` | `--glass-blur-sm` (7px) | entrata del popover |
| `mirror.css:329` | `filter: blur(3px)` (keyframe) | `--glass-blur-scrim` (stesso valore) | lasciato letterale di proposito: è un'animazione d'entrata, non lo scrim; usare il token di vetro qui legherebbe due cose diverse |
| `outfits.css:115` | `filter: blur(12px)` | — | placeholder della foto in caricamento |

Proposta per gli step successivi: un token di motion `--blur-enter` per le tre entrate (3, 4, 6px → un valore), lasciando i `--glass-blur*` ai vetri.

### Spaziatura

650 occorrenze, 49 valori distinti, nelle stesse proprietà del consolidamento. I valori sotto 4px sono quasi tutti compensazioni ottiche o di bordo e possono restare; i negativi sono compensazioni di margine. I gruppi che contano davvero per la coerenza sono 6, 10, 14, 18, 20, 22 e 28px: 372 occorrenze in tutto, con 10px da solo a 102.

| Valore | Occorrenze | Token più vicino | Dove (file:riga, `src/` omesso) |
| --- | --- | --- | --- |
| `-1px` | 3 | sotto la scala (hairline/ottico) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | inspo.css:60, settings-modal.css:25, styles.css:265 |
| `1px` | 9 | sotto la scala (hairline/ottico) | color-profile.css:132, color-profile.css:612, components/piece-picker.css:99, declutter.css:253, google-drive-storage.css:79, onboarding.css:123, overview.css:204, styles.css:2646, styles.css:3364 |
| `1.5px` | 1 | sotto la scala (hairline/ottico) | styles.css:512 |
| `-2px` | 3 | sotto la scala (hairline/ottico) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | overview.css:173, styles.css:2207, styles.css:2983 |
| `2px` | 30 | sotto la scala (hairline/ottico) | cheat-sheets.css:55, color-profile.css:613, color-profile.css:630, color-profile.css:798, components/mobile-chrome.css:223, declutter.css:15, declutter.css:123, import-flow.css:52, mirror.css:271, mirror.css:291, mirror.css:364, onboarding.css:222, onboarding.css:329, onboarding.css:372, onboarding.css:583, onboarding.css:608, overview.css:44, overview.css:242, styles.css:678, styles.css:679, styles.css:1004, styles.css:1529, styles.css:1987, styles.css:2163, styles.css:2168, styles.css:2648, styles.css:2782, styles.css:2833, styles.css:2984 |
| `3px` | 22 | sotto la scala (hairline/ottico) | cheat-sheets.css:178, color-profile.css:303, color-profile.css:663, color-profile.css:872, components/hot-cards.css:95, components/hot-cards.css:124, components/mobile-chrome.css:211, components/piece-picker.css:99, components/piece-picker.css:134, declutter.css:16, google-drive-storage.css:80, onboarding.css:446, overview.css:136, overview.css:250, overview.css:251, styles.css:327, styles.css:1003, styles.css:1770, styles.css:1847, styles.css:2055, styles.css:3237 |
| `-4px` | 5 | −`--s-1` (4) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | inspo.css:210, overview.css:287, styles.css:2207 |
| `-5px` | 2 | −`--s-1` (4) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | overview.css:288, styles.css:2207 |
| `5px` | 30 | `--s-1` (4) | cheat-sheets.css:2, cheat-sheets.css:13, cheat-sheets.css:51, cheat-sheets.css:54, color-profile.css:324, color-profile.css:513, color-profile.css:717, color-profile.css:902, components/confirm-dialog.css:5, components/mobile-chrome.css:178, components/mobile-chrome.css:225, declutter.css:303, google-drive-storage.css:90, import-flow.css:52, import-flow.css:198, onboarding.css:123, onboarding.css:591, overview.css:178, overview.css:180, overview.css:253, overview.css:360, overview.css:361, styles.css:2192, styles.css:2195, styles.css:2690, styles.css:2996, suggestions.css:66 |
| `-6px` | 7 | −`--s-1` (4) / `--s-2` (8) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | inspo.css:210, onboarding.css:66, styles.css:2923, styles.css:3234 |
| `6px` | 62 | `--s-1` (4) / `--s-2` (8) | cheat-sheets.css:66, cheat-sheets.css:92, cheat-sheets.css:110, cheat-sheets.css:166, cheat-sheets.css:185, cheat-sheets.css:188, cheat-sheets.css:189, color-profile.css:71, color-profile.css:109, color-profile.css:231, color-profile.css:248, color-profile.css:656, color-profile.css:718, components/buttons.css:145, components/buttons.css:197, components/mobile-chrome.css:178, components/mobile-chrome.css:211, components/mobile-chrome.css:225, components/piece-picker.css:29, components/piece-picker.css:31, components/piece-picker.css:192, declutter.css:27, declutter.css:253, google-drive-storage.css:7, google-drive-storage.css:68, import-flow.css:108, import-flow.css:115, import-flow.css:185, inspo.css:78, inspo.css:158, inspo.css:176, mirror.css:59, mirror.css:62, onboarding.css:41, onboarding.css:183, onboarding.css:241, onboarding.css:278, onboarding.css:393, outfits.css:262, overview.css:112, overview.css:262, overview.css:356, styles.css:690, styles.css:809, styles.css:817, styles.css:892, styles.css:1665, styles.css:1679, styles.css:2184, styles.css:2362, styles.css:2736, styles.css:2787, styles.css:2818, styles.css:3099, styles.css:3102, styles.css:3240, styles.css:3245, suggestions.css:65, suggestions.css:92, suggestions.css:236, suggestions.css:269, suggestions.css:270 |
| `7px` | 24 | `--s-2` (8) | cheat-sheets.css:106, cheat-sheets.css:121, components/buttons.css:45, declutter.css:135, declutter.css:143, google-drive-storage.css:58, google-drive-storage.css:64, onboarding.css:222, outfits.css:221, overview.css:136, overview.css:172, overview.css:251, overview.css:253, overview.css:257, overview.css:344, settings-modal.css:24, styles.css:725, styles.css:859, styles.css:1611, styles.css:2324, styles.css:3027, styles.css:3100, styles.css:3364, suggestions.css:102 |
| `-8px` | 8 | −`--s-2` (8) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | color-profile.css:167, google-drive-storage.css:28, overview.css:135, styles.css:1760, styles.css:2020, styles.css:2923 |
| `9px` | 24 | `--s-2` (8) | color-profile.css:276, color-profile.css:444, color-profile.css:808, color-profile.css:849, components/piece-picker.css:41, google-drive-storage.css:96, import-flow.css:124, import-flow.css:179, inspo.css:12, inspo.css:52, inspo.css:94, inspo.css:216, onboarding.css:131, outfits.css:242, overview.css:337, overview.css:338, overview.css:357, settings-modal.css:26, styles.css:405, styles.css:830, styles.css:1850, styles.css:2258 |
| `-10px` | 1 | −`--s-2` (8) / `--s-3` (12) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | onboarding.css:52 |
| `10px` | 102 | `--s-2` (8) / `--s-3` (12) | cheat-sheets.css:65, cheat-sheets.css:106, cheat-sheets.css:121, cheat-sheets.css:162, cheat-sheets.css:185, cheat-sheets.css:207, color-profile.css:96, color-profile.css:113, color-profile.css:158, color-profile.css:223, color-profile.css:428, color-profile.css:530, color-profile.css:640, color-profile.css:641, color-profile.css:738, color-profile.css:759, color-profile.css:799, color-profile.css:806, color-profile.css:873, components/mobile-chrome.css:110, components/piece-picker.css:26, components/piece-picker.css:50, components/piece-picker.css:169, components/piece-picker.css:170, components/piece-picker.css:173, components/piece-picker.css:178, google-drive-storage.css:22, google-drive-storage.css:26, google-drive-storage.css:29, google-drive-storage.css:30, google-drive-storage.css:49, google-drive-storage.css:75, google-drive-storage.css:84, google-drive-storage.css:95, import-flow.css:118, import-flow.css:130, import-flow.css:148, inspo.css:12, inspo.css:94, inspo.css:117, mirror.css:173, onboarding.css:53, onboarding.css:82, onboarding.css:146, onboarding.css:171, onboarding.css:177, onboarding.css:361, onboarding.css:536, onboarding.css:558, outfits.css:212, outfits.css:267, outfits.css:319, outfits.css:373, outfits.css:470, overview.css:19, overview.css:165, overview.css:180, overview.css:247, overview.css:250, overview.css:266, overview.css:321, overview.css:355, settings-modal.css:16, styles.css:298, styles.css:1215, styles.css:1611, styles.css:1741, styles.css:1755, styles.css:1963, styles.css:2001, styles.css:2030, styles.css:2100, styles.css:2322, styles.css:2323, styles.css:2332, styles.css:2357, styles.css:2358, styles.css:2588, styles.css:2589, styles.css:2635, styles.css:2638, styles.css:2757, styles.css:2771, styles.css:2787, styles.css:2801, styles.css:2902, styles.css:2903, styles.css:2930, styles.css:2971, styles.css:2981, styles.css:3047, styles.css:3060, styles.css:3108, styles.css:3254, suggestions.css:37, suggestions.css:53 |
| `11px` | 21 | `--s-3` (12) | cheat-sheets.css:39, color-profile.css:457, color-profile.css:873, components/piece-picker.css:27, google-drive-storage.css:16, google-drive-storage.css:17, import-flow.css:179, import-flow.css:189, onboarding.css:260, outfits.css:319, overview.css:60, overview.css:136, overview.css:247, overview.css:260, styles.css:1850, styles.css:2195, styles.css:2329, styles.css:2352, styles.css:2699, styles.css:3268, styles.css:3384 |
| `-12px` | 1 | −`--s-3` (12) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | overview.css:148 |
| `13px` | 14 | `--s-3` (12) | color-profile.css:280, declutter.css:144, google-drive-storage.css:16, google-drive-storage.css:17, google-drive-storage.css:75, google-drive-storage.css:84, overview.css:163, overview.css:245, overview.css:275, overview.css:293, styles.css:1499, styles.css:2352, styles.css:2690, suggestions.css:53 |
| `14px` | 66 | `--s-3` (12) / `--s-4` (16) | cheat-sheets.css:44, cheat-sheets.css:95, cheat-sheets.css:117, cheat-sheets.css:189, cheat-sheets.css:191, color-profile.css:231, color-profile.css:367, color-profile.css:427, color-profile.css:503, color-profile.css:644, color-profile.css:707, color-profile.css:733, components/piece-picker.css:16, components/piece-picker.css:23, components/piece-picker.css:46, components/piece-picker.css:177, components/piece-picker.css:185, components/piece-picker.css:193, declutter.css:27, declutter.css:303, google-drive-storage.css:26, import-flow.css:110, import-flow.css:146, import-flow.css:174, import-flow.css:184, inspo.css:158, mirror.css:246, mirror.css:247, onboarding.css:187, onboarding.css:289, onboarding.css:293, onboarding.css:361, onboarding.css:399, onboarding.css:558, onboarding.css:613, onboarding.css:614, outfits.css:374, outfits.css:510, outfits.css:512, overview.css:162, overview.css:173, overview.css:269, overview.css:282, settings-modal.css:26, styles.css:299, styles.css:335, styles.css:353, styles.css:780, styles.css:1499, styles.css:1760, styles.css:2080, styles.css:2261, styles.css:2309, styles.css:2605, styles.css:2688, styles.css:2903, styles.css:3099, styles.css:3203, styles.css:3224, suggestions.css:36, suggestions.css:146, suggestions.css:379 |
| `15px` | 14 | `--s-4` (16) | color-profile.css:280, google-drive-storage.css:26, google-drive-storage.css:87, google-drive-storage.css:96, onboarding.css:469, overview.css:63, overview.css:246, overview.css:335, overview.css:359, styles.css:368, styles.css:1810, styles.css:2258, styles.css:2329, suggestions.css:104 |
| `17px` | 4 | `--s-4` (16) | google-drive-storage.css:66, overview.css:199, overview.css:335, styles.css:830 |
| `-18px` | 1 | −`--s-4` (16) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | styles.css:815 |
| `18px` | 42 | `--s-4` (16) | cheat-sheets.css:29, cheat-sheets.css:72, cheat-sheets.css:92, color-profile.css:417, color-profile.css:739, components/mobile-chrome.css:26, components/piece-picker.css:48, import-flow.css:107, import-flow.css:109, import-flow.css:217, mirror.css:192, mirror.css:391, onboarding.css:133, onboarding.css:147, onboarding.css:346, onboarding.css:537, outfits.css:234, outfits.css:235, outfits.css:241, outfits.css:293, outfits.css:562, overview.css:11, overview.css:29, overview.css:235, overview.css:275, overview.css:293, overview.css:321, overview.css:335, overview.css:353, styles.css:817, styles.css:1541, styles.css:2100, styles.css:2327, styles.css:2362, styles.css:2833, styles.css:3127, styles.css:3202, styles.css:3213, styles.css:3214, suggestions.css:439, suggestions.css:441 |
| `19px` | 1 | `--s-4` (16) | google-drive-storage.css:14 |
| `-20px` | 1 | −`--s-4` (16) / `--s-5` (24) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | outfits.css:393 |
| `20px` | 50 | `--s-4` (16) / `--s-5` (24) | cheat-sheets.css:36, cheat-sheets.css:47, cheat-sheets.css:72, cheat-sheets.css:117, cheat-sheets.css:122, cheat-sheets.css:127, cheat-sheets.css:181, color-profile.css:85, color-profile.css:439, color-profile.css:832, color-profile.css:844, components/confirm-dialog.css:3, components/confirm-dialog.css:13, components/piece-picker.css:16, components/piece-picker.css:45, components/piece-picker.css:46, components/piece-picker.css:47, components/piece-picker.css:177, import-flow.css:107, import-flow.css:118, import-flow.css:172, import-flow.css:219, inspo.css:30, inspo.css:44, mirror.css:58, mirror.css:135, mirror.css:317, onboarding.css:52, outfits.css:511, overview.css:16, overview.css:37, overview.css:199, overview.css:268, overview.css:274, overview.css:280, overview.css:281, styles.css:1646, styles.css:1936, styles.css:2332, styles.css:2360, styles.css:2361, styles.css:3115, styles.css:3126, styles.css:3203, styles.css:3214, styles.css:3224, styles.css:3304, suggestions.css:439 |
| `22px` | 29 | `--s-5` (24) | cheat-sheets.css:191, color-profile.css:92, color-profile.css:150, color-profile.css:279, color-profile.css:414, color-profile.css:845, import-flow.css:205, import-flow.css:224, onboarding.css:109, onboarding.css:516, onboarding.css:538, outfits.css:471, settings-modal.css:11, settings-modal.css:50, styles.css:781, styles.css:815, styles.css:1624, styles.css:1645, styles.css:2257, styles.css:2292, styles.css:2316, styles.css:2325, styles.css:2355, styles.css:2360, styles.css:2525, styles.css:2531, styles.css:2968, styles.css:3050, suggestions.css:147 |
| `26px` | 5 | `--s-5` (24) | onboarding.css:42, onboarding.css:132, onboarding.css:172, suggestions.css:22, suggestions.css:439 |
| `28px` | 21 | `--s-5` (24) / `--s-6` (32) | cheat-sheets.css:3, cheat-sheets.css:63, components/confirm-dialog.css:4, components/piece-picker.css:16, import-flow.css:8, import-flow.css:141, import-flow.css:142, import-flow.css:219, mirror.css:28, mirror.css:29, mirror.css:103, overview.css:4, overview.css:11, overview.css:29, overview.css:30, overview.css:154, overview.css:291, styles.css:769, styles.css:2256, styles.css:2346, styles.css:2531 |
| `-30px` | 1 | −`--s-6` (32) · negativo: `calc(-1 * var(…))` se si vuole tokenizzare | components/hot-cards.css:9 |
| `30px` | 12 | `--s-6` (32) | components/hot-cards.css:24, outfits.css:4, styles.css:901, styles.css:1742, styles.css:2238, styles.css:2240, styles.css:2309, styles.css:2355, styles.css:2520, styles.css:2551, suggestions.css:21 |
| `34px` | 6 | `--s-6` (32) | outfits.css:4, styles.css:1175, styles.css:1630, styles.css:1741, styles.css:2500, suggestions.css:193 |
| `35px` | 1 | `--s-6` (32) | overview.css:157 |
| `38px` | 2 | `--s-6` (32) | onboarding.css:21, styles.css:2309 |
| `40px` | 5 | `--s-6` (32) / `--s-7` (48) | mirror.css:76, onboarding.css:20, outfits.css:5, styles.css:758, styles.css:903 |
| `42px` | 2 | `--s-7` (48) | styles.css:1174, styles.css:2500 |
| `44px` | 3 | `--s-7` (48) | outfits.css:319, outfits.css:556, overview.css:347 |
| `46px` | 3 | `--s-7` (48) | styles.css:1176, styles.css:1630, styles.css:2500 |
| `60px` | 1 | `--s-8` (64) | mirror.css:287 |
| `62px` | 1 | `--s-8` (64) | styles.css:1476 |
| `68px` | 1 | `--s-8` (64) | cheat-sheets.css:14 |
| `70px` | 1 | `--s-8` (64) | styles.css:1071 |
| `72px` | 1 | `--s-8` (64) | color-profile.css:504 |
| `76px` | 2 | `--s-8` (64) | cheat-sheets.css:117, cheat-sheets.css:189 |
| `78px` | 1 | `--s-8` (64) | styles.css:2551 |
| `90px` | 1 | `--s-8` (64) | styles.css:2262 |
| `96px` | 2 | `--s-8` (64) | styles.css:903, styles.css:2333 |
| `100px` | 1 | `--s-8` (64) | overview.css:4 |
