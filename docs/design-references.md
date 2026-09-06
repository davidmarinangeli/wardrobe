# Design references

Where the visual direction comes from, so it lives somewhere readable instead of
in chat scrollback. Companion to the **Motion and material overhaul** ticket on
the Wardrobbing Kanban board.

Reference images go in this folder — the convention `color_scheme_inspo.png`
already started. Name them for what they show, not where they came from.

## The three that define the direction

**[devouringdetails.com](https://devouringdetails.com)** — the *physics* register.
Not "add a spring easing": the point is that a gesture carries momentum, that
resistance builds as you push past a limit, and that releasing something fast
should commit even if you didn't drag it far. The suggestion deck
(`src/suggestions.jsx`) is the one surface in this app that already has a real
drag and currently ignores all of it — it tracks pointer position and nothing
else.

**[Raycast](https://raycast.com)** — the *material*. Frosted glass, layered
translucency, one light edge along the top of every raised surface. The caveat
worth writing down: Raycast's bloom depends on a dark ground. On this app's cream
field a glow barely registers, so the decision (2026-09-02) is **stay warm, swap
the register** — depth comes from contact shadows, layered translucency and grain
instead, and glow stays reserved for the AI moments where `--glass-*` and the
border beam already earn it.

**[animations.dev](https://animations.dev)** — the *morphing*. Dynamic
Island-style transitions where one element becomes another rather than one
fading over another. Same author as the skills already vendored in
`.claude/skills/` (`emil-design-eng`, `animate`, `animation-vocabulary`,
`review-animations`), so the vocabulary and standards are already in this repo —
read those first, they're more specific than anything a screenshot will tell you.

## When more are needed

- **[Mobbin](https://mobbin.com)** — real product flows, screen by screen. The
  most useful of these, because it shows what a feature looks like across its
  whole state machine, not just its happy path.
- **[Godly](https://godly.website)** / **[Land-book](https://land-book.com)** —
  site craft, typography and layout.
- **[Cosmos](https://cosmos.so)** / **[Refero](https://refero.design)** — boards,
  better than Savee for interface work specifically.
- **[rauno.me](https://rauno.me)** — interaction detail, written up rather than
  just shown.

Worth pulling apart directly, in a browser with devtools open: Linear (density
and keyboard), Raycast (material), Family (motion), Arc, Vercel's dashboard.

## House rules that override any reference

`.claude/skills/review-animations/STANDARDS.md` wins over anything found here.
The load-bearing ones: transform and opacity only, `ease-out` for things
arriving, origin at the trigger for anything anchored to one, and every bit of
it reduced-motion aware.
