---
name: Wardrobe
description: A local-first digital wardrobe in warm paper and glass, where the garments are the colour.
colors:
  paper: "#f4f0e8"
  paper-warm: "#f7f2e9"
  paper-raised: "#fbf7f0"
  surface-stage: "#eee7d9"
  ink: "#191919"
  ink-soft: "#2e2a26"
  muted: "#6d675f"
  line: "#d8d0c3"
  oxblood: "#6e302e"
  oxblood-warm: "#8c4436"
  sage-success: "#4e6350"
  brick-error: "#8a3f35"
  danger-red: "#b23a2a"
  dark-glass-solid: "#2b2621"
  dark-glass-ink: "#f7f2e9"
typography:
  display:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  subsection:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  caption:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  eyebrow:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "28px"
  full: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  s-8: "64px"
  page-x: "56px"
  item-pad: "14px"
components:
  button-primary:
    backgroundColor: "{colors.oxblood}"
    textColor: "{colors.paper}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.oxblood-warm}"
  button-secondary:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "38px"
  button-ghost:
    textColor: "{colors.oxblood}"
    rounded: "{rounded.full}"
    height: "38px"
  button-danger:
    textColor: "{colors.danger-red}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "38px"
  button-icon:
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.full}"
    size: "40px"
  chip-filter:
    textColor: "{colors.muted}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.full}"
    padding: "9px 17px"
    height: "38px"
  chip-filter-active:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink-soft}"
  view-switch-tab:
    textColor: "{colors.muted}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.full}"
    padding: "7px 16px"
    height: "34px"
  view-switch-tab-active:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink-soft}"
  card-garment-art:
    rounded: "{rounded.lg}"
    padding: "{spacing.item-pad}"
  card-outfit-art:
    backgroundColor: "{colors.surface-stage}"
    rounded: "{rounded.lg}"
  input-field:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    height: "42px"
  panel:
    backgroundColor: "{colors.paper-warm}"
    rounded: "{rounded.xl}"
  menu:
    backgroundColor: "{colors.paper-raised}"
    rounded: "{rounded.md}"
    padding: "6px"
---

# Design System: Wardrobe

<!-- Recorded from the shipped code on ui/impeccable@372b395 (step 0a of docs/impeccable/plan.md). The qualitative language (North Star, colour names, rules) was written by a delegated agent without the owner's interview and is marked "(da confermare)" where it goes beyond what the code says. The tokens are normative and come from src/styles.css :root and src/components/buttons.css. -->

## Overview

**Creative North Star: "The Warm Atelier Rail"** (da confermare)

Wardrobe is a quiet workroom for the clothes someone already owns. Everything around the garments is warm paper: a cream field lit by three soft radial pools and a barely visible grain, so that `backdrop-filter` has something real to blur. The garments are the only saturated things on screen; the interface keeps to ink, muted taupe and one oxblood accent that marks the single action a view is for.

Depth is material rather than decorative. Cards are translucent warm fills with a lit top edge and a warm, soft shadow; chrome that content scrolls under is real frosted glass; floating controls on a phone switch to a dark, refracting glass register so the colour passing underneath becomes the thing you see. Panels and dialogs are opaque paper with the largest radius in the set, sitting on a lightly blurred scrim. Motion is short, exponential, and grows from the thing that was touched.

The surface mode is Operate: the user is in a task (find a piece, build an outfit, decide what to keep), so consistency and scanability outrank expression, and the brand lives in the precise details: the warm shadow tint, the lit edge, the contact shadow under a cut-out.

**Key Characteristics:**
- Warm neutrals only; nothing pure black on pure white. `--ink-soft` carries body copy, `--ink` is for emphasis and filled surfaces.
- One accent (oxblood) for the one primary action, selection rings and accent ink; never decoration.
- Glass in four registers (card fill, light chrome, panel, dark chrome), each with its own blur budget.
- Generous, consistent rounding: five radius steps plus pill.
- One sans family (Instrument Sans Variable) carrying every role; levels differ by size, headings are all weight 500.
- Short, purposeful motion (140 / 180 / 260 ms) with custom ease-out curves; every effect has a reduced-motion and reduced-transparency fallback.

## Colors

A restrained warm-paper palette with one oxblood accent; colour comes from the garments, not the interface.

### Primary
- **Oxblood** (`--accent`): the primary button fill, the active underline of Overview's tabs, accent ink on ghost buttons and links, the "Matches my colours" active ring. At most one filled oxblood control per section.
- **Warm Oxblood** (`--accent-warm`): hover state of the primary, every focus ring (`2px solid`), selection rings on cards and variant tiles, the count ink on garment captions ("in 3 looks").

### Neutral
- **Paper** (`--paper`): the page field under the radial gradient and grain; the text colour on filled buttons.
- **Warm Paper** (`--paper-warm`): the background of every panel, sheet and dialog (`.viewer`) and of their fixed footers.
- **Raised Paper** (`--paper-raised`): raised controls: secondary buttons, fields, menus, the active pill in segmented controls and the filter row.
- **Stage** (`--surface-stage`): the ground a photo or flat lay sits on (outfit cards, item stage, declutter card, variant strip). The one surface that goes darker instead of lighter, so a white cut-out still reads as an object.
- **Ink** (`--ink`): titles, emphasis, the filled "All" chip in the picker, the active Settings underline.
- **Soft Ink** (`--ink-soft`): body copy and default control text.
- **Taupe** (`--muted`): captions, meta, counts, eyebrows, inactive tabs and chips, placeholder text.
- **Hairline** (`--line`): borders of fields, secondary buttons, menus and outfit cards; dividers.
- **Washes** (`--wash-1/2/3`, translucent soft ink at 4.5 / 9 / 16%): hover fills, segmented-control tracks, inactive filter chips, row dividers.
- **Scrim** (`--scrim`): the dimmed layer under every panel, with `--glass-blur-scrim`.

### Status
- **Sage** (`--success`): saved / connected states, the Drive status dot, success copy.
- **Brick** (`--error`): inline error text and error callouts.
- **Danger Red** (`--danger`, defined in `src/components/buttons.css`): destructive buttons only (outlined by default, solid only on the final confirming step). Deliberately redder and lighter than the accent so a destructive action never reads as the primary.

### Dark glass register
- **Dark Glass** (`--glass-dark`, translucent `rgba(30, 26, 22, .32)`), its solid fallback **Dark Glass Solid** (`--glass-dark-solid`), with **Dark Glass Ink** / muted ink for labels. Only on phone chrome that floats over scrolling content: the bottom nav and the floating secondary actions.

### Named Rules
**The One Voice Rule.** Oxblood fills at most one control per section; a second filled button in the same view is a bug, not emphasis. (The global top bar counts as its own section.)

**The Garments Are the Colour Rule.** No new brand colours, gradients or tinted panels. Hue on screen comes from photos, cut-outs and the season palette swatches. (Binding for this UI round: `docs/impeccable/plan.md`.)

**The Warm Shadow Rule.** Every shadow is tinted `rgba(60, 47, 33, …)`; a cool grey shadow on cream reads as dirt.

## Typography

**Display Font:** Instrument Sans Variable (with Helvetica Neue, Arial)
**Body Font:** the same family.

**Character:** a single contemporary grotesque doing every job: tightened tracking at large sizes gives titles a calm editorial voice, small tracked caps give labels structure without a second face.

### Hierarchy
- **Display** (500, 32px, 1.05, -0.035em): the one page title (h1) per view: "Wardrobe", "Overview", "Inspo".
- **Title** (500, 22px, 1.15, -0.025em): dialog, sheet and popover titles; page section headings (h2).
- **Section** (500, 18px, 1.25): a section inside a dialog or page (h3); at regular weight, the one-line statements (Declutter lede, Mirror verdict).
- **Subsection** (500, 15px, 1.25): sub-sections (h4) and card titles (outfit and cheat-sheet captions).
- **Body** (400, 13px, 1.5): running text, field values, buttons, tabs, chips, garment names.
- **Caption** (400, 11px, 1.4): meta, counts, hints, helper text.
- **Eyebrow** (500, 11px, +0.06em, uppercase): the label voice: field labels, detail-row keys, section labels, category chips, the top view switch.

Two functional exceptions: `--text-input-touch` (16px) keeps phone fields from triggering iOS zoom; `--text-micro` (9px) is only the aria-hidden P/T glyph in the Gemini badge.

### Named Rules
**The Six Sizes Rule.** Every `font-size` is a `--text-*` token; no hand-set px values. Levels differ by size, not weight: every heading is 500, 600 is for emphasis inside body text and short labels.

**The 11px Floor Rule.** Nothing smaller than 11px except the two documented exceptions.

## Layout

- **Page gutter:** one value, `--page-x` (56px desktop, 24px on a phone); the top bar, page header and grid all align to it.
- **Spacing scale:** `--s-1…--s-8` (4, 8, 12, 16, 24, 32, 48, 64), extracted from a hand-written 4px grid. Many hand-tuned values remain (5, 6, 7, 9, 10, 14, 18, 20, 22, 28px); they are inventoried in `docs/impeccable/components.md` § "Valori orfani" and are not yet decided.
- **Desktop shell (>860px):** a sticky glass top bar (view switch left, "How do I look?" + the primary add action + Settings gear right); below it the page h1 (`.mobile-headrow` reused as the large title), then the page header (count, filters, hot cards) and an auto-fill grid (`minmax(210px, 1fr)` for garments, 4 columns of 3:4 outfit cards).
- **Phone shell (≤860px):** a large-title header row with the gear; a floating dark-glass bottom nav (`--nav-h` 60px, floating `--nav-gap` 9px off the bottom, `--nav-inset` reserved under content); the secondary and primary page actions float above the nav. Panels become bottom sheets with a drag gesture and the page scales back behind them.
- **Panels:** side sheet `clamp(390px, 34vw, 520px)` wide on desktop, full-height with a 28px radius; centred dialogs for Settings, popovers and the wizard; the piece picker and cheat-sheet editor go near full-screen.
- **Density:** comfortable, not dense: 52px detail rows, 38px controls on desktop, 44px touch floor on a phone (`--btn-h`, `--btn-icon`).

## Elevation & Depth

A hybrid system: translucent material plus warm, soft, offset shadows. Raised things get a lit top edge (`--glass-edge`, an inset 1px white line) and a shadow from the scale; photos and cut-outs get a contact shadow as `filter: drop-shadow` so the shadow follows the garment's silhouette.

### Glass surface levels
- **Card** (`--glass-card` / `--glass-card-hover`, a 160° warm translucent gradient; border `--glass-border`; `--glass-edge` + `--shadow-sm`). Garment cards, hot cards, picker tiles, import cards, mirror issue cards. No backdrop-filter: on 55+ grid elements a fill reads the same over the gradient field without the blur cost.
- **Chrome** (`--glass-chrome` with `--glass-blur`, 20px + saturate 155%). The desktop top bar, applied through a pseudo-element so fixed popovers inside it are not trapped.
- **Panel** (opaque `--paper-warm`, `--glass-border`, `--glass-edge` + `--shadow-lg`, radius `--r-xl`), over `--scrim` + `--glass-blur-scrim` (3px). Overlays inside a panel (sticky photo bar, close button over a photo, on-media buttons) frost with `--glass-blur-panel` (14px) or `--glass-blur-sm` (7px).
- **Sheet** (the phone form of the panel): same material, attached to the bottom edge, top corners only, with a drag handle and page scale-back.
- **Dark glass** (`--glass-dark`, `--glass-blur-chrome` 10px with no saturate, `--glass-dark-border`, `--glass-dark-edge`, refraction via `useGlassSurface` / `GlassFilter.jsx`). Phone bottom nav and floating secondary actions only; falls back to `--glass-dark-solid` under `prefers-reduced-transparency`.

### Shadow Vocabulary
- **xs** (`--shadow-xs`): resting chips, small floating labels, the segmented active pill in dense places.
- **sm** (`--shadow-sm`): resting cards, active filter pill, primary button at rest.
- **md** (`--shadow-md`): hover lift of cards and buttons.
- **lg** (`--shadow-lg`): panels, dialogs, menus, the dragged suggestion card.
- **contact / contact-lift** (`--shadow-contact*`, drop-shadow filters): garments standing on a card; lifted on hover.
- **focus ring** (`--ring-focus`, 3px warm halo): fields on focus, together with an `--accent-warm` border.

### Named Rules
**The Blur Budget Rule.** Blur radius is a performance budget, not a style knob: 20px only on the desktop chrome, 14px on panel overlays, 10px with no saturate on anything floating over scrolling content on a phone, 3px on the full-viewport scrim. Never add a new blur value.

**The Lit Edge Rule.** Anything raised carries `--glass-edge` alongside its shadow; anything glass carries `--glass-border`.

## Shapes

Soft, generous rounding everywhere, no sharp corners. Five steps plus pill (`--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 20, `--r-xl` 28, `--r-full`): small marks and checkboxes take xs; fields and tiles take sm; menus, cheat-sheet covers and inner callouts take md; cards take lg; panels and dialogs take xl; every button, chip, tab and segmented control is a pill. Borders are 1px hairlines (`--line` on opaque surfaces, `--glass-border` on glass). Circles use 50% only for dots and avatars.

**The Five Radii Rule.** Every rectangular surface picks one of the five steps; nothing invents its own (three hand-set radii remain, listed as orphans).

## Components

### Buttons
One vocabulary in `src/components/buttons.css`; component rules restyle a variant only through `--btn-*` custom properties.
- **Shape:** pill (`--r-full`); 38px default, 32px `.button--sm`, 44px `.button--lg`; 44px for default and icon buttons under 860px.
- **Primary:** oxblood fill, paper text, `--shadow-sm`; hover to warm oxblood with `--shadow-md`. One per section, last in its row, never destructive.
- **Secondary:** raised paper, hairline border; hover darkens the border to taupe and adds `--shadow-sm`.
- **Ghost:** text only in accent ink, for tertiary actions and disclosures.
- **Danger:** danger-red ink and a 36% danger border; `.danger-button--solid` only for the final confirming step.
- **Icon:** 40px circle, transparent; `--outlined` and `--danger` tones; must carry an aria-label.
- **On media:** `.button--on-media` frosts any variant with `--glass-blur-panel` for controls over a photo.
- **States:** press `scale(.97)` (`.92` for icon buttons), disabled at 45% opacity, focus `2px solid --accent-warm` offset 2px.
- **AI actions:** the generate button pairs a primary pill with a tier menu (Standard / Premium); inside a view that already has its own commit it takes the secondary tone.

### Chips
- **Filter chip (category row):** pill, wash fill, taupe eyebrow caps; active is raised paper with glass border and `--shadow-sm`. The colour filter adds a season dot and an oxblood ring when active.
- **Picker chips:** sentence case, raised paper with a hairline; active fills with ink. Tag chips carry a tabular count.
- **Tags:** read-only tags in the item viewer are small glass pills in lowercase; outfit style tags are uppercase pills. Not yet unified (see `docs/impeccable/components.md`).

### Cards / Containers
- **Garment card:** art box `--r-lg`, `--glass-card` fill, `--glass-border`, `--glass-edge` + `--shadow-sm`, padding `--item-pad`; caption outside below (name in body, type in eyebrow caps, outfit count in warm oxblood). Hover lifts 3px to `--shadow-md`.
- **Outfit card:** 3:4 art on `--surface-stage` with a hairline border, same radius and shadow; the name sits on a paper gradient inside the art, revealed on hover where hover exists.
- **Hot card:** a horizontal glass card with icon, eyebrow, title, description and arrow.
- **Cheat-sheet card:** white cover `--r-md` with a hairline, caption outside (subsection semibold title + caption meta).
- **Selection:** a 1px warm-oxblood ring plus the card's shadow.

### Inputs / Fields
- **Style:** raised paper, 1px hairline, `--r-sm`, 42-44px tall, body text; labels above in eyebrow caps.
- **Focus:** border to warm oxblood plus `--ring-focus`.
- **Search:** the Overview search is a 48px pill with a leading icon; the picker search is a rectangular field. Not yet unified.
- **Error:** brick text below the field.

### Navigation
- **View switch (desktop):** a wash-1 pill track with three uppercase eyebrow tabs; the active tab is a raised paper pill with `--shadow-sm`.
- **Bottom nav (phone):** dark glass bar with icon + label tabs and a sliding pill; collapses to icons while scrolling.
- **Sub-navigation:** Overview uses underline tabs (oxblood underline); Settings uses underline tabs (ink underline); Declutter uses a segmented pill; the Inspo importer uses full-width uppercase underline tabs. Not yet unified.

### Panel (signature component)
`ViewerPanel` is the frame for every side sheet and dialog: a fixed header (title in `--text-title`, left; close at a fixed `--viewer-close-inset` from the corner, right; optional second row for tabs), a body that is the only scroller, and a fixed footer for the action row. The header hairline appears only once content scrolls under it; the footer hairline only while there is more below. Photo-led panels float the controls over the photo in a bar that turns to glass with the name once the name scrolls away. On a phone the same panel is a bottom sheet.

### Menu
`.sheet-menu`: raised paper, hairline, `--r-md`, 6px padding, `--shadow-lg`; group labels in taupe, destructive rows in danger ink. The tier menu is the same component anchored above the generate button.

## Do's and Don'ts

### Do:
- **Do** take every colour from the `:root` tokens; add no new brand colour.
- **Do** use `--r-*` for every corner, `--shadow-*` for every shadow, `--glass-blur*` for every blur and `--s-*` for spacing that lands on the scale.
- **Do** use the button classes from `buttons.css` and re-theme them only through `--btn-*`.
- **Do** keep one filled oxblood action per section and put it last in its row.
- **Do** build every modal on `ViewerPanel`'s header / body / footer anatomy.
- **Do** give every raised surface `--glass-edge` and every garment a contact shadow.
- **Do** provide `prefers-reduced-motion` and `prefers-reduced-transparency` fallbacks for every new effect.

### Don't:
- **Don't** set a `font-size` outside the `--text-*` scale or below 11px.
- **Don't** add backdrop-filter to grid cards, or a blur radius outside the five `--glass-blur*` tokens.
- **Don't** use cool grey or black shadows, or a zero-offset coloured glow outside the AI moments that already have one.
- **Don't** put a second filled primary in a view, or make a destructive action filled except at its final confirmation.
- **Don't** add a top-level nav destination for a secondary feature; it belongs in a hot card or a panel.
- **Don't** stack an uppercase eyebrow above a title that already names the thing (see `docs/impeccable/audit.md`).
