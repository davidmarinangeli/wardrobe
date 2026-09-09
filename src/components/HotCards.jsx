import { ArrowRight, Sparkle } from "@phosphor-icons/react";

/**
 * A scrollable strip of cards between a page header and its grid, each one a
 * door into a feature that does not deserve a permanent nav slot.
 *
 * This is the counterpart to SuggestionNudges rather than a copy of it. A nudge
 * tells you something and carries no button on purpose — pointing a button at
 * another button is the problem it was avoiding. A hot card IS the way in, so an
 * action here is the whole point, and there is nothing else it could duplicate.
 *
 * Props
 * ─────
 * cards  array – [{ id, eyebrow, title, body, icon?, accent?, swatches?, progress?, onOpen }]
 *                `accent` recolours the icon badge for a card with its own identity
 *                (the season card wears its season); the rest use the app accent.
 */
export function HotCards({ cards = [], label = "Suggestions" }) {
  if (!cards.length) return null;

  return (
    <div className="hot-cards" role="region" aria-label={label}>
      <div className="hot-cards__rail">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            className="hot-card"
            onClick={card.onOpen}
            style={card.accent ? { "--hot-card-accent": card.accent } : undefined}
          >
            <span className="hot-card__icon" aria-hidden="true">
              {card.icon || <Sparkle size={15} weight="regular" />}
            </span>

            <span className="hot-card__body">
            {card.eyebrow && <span className="hot-card__eyebrow">{card.eyebrow}</span>}
            <span className="hot-card__title">{card.title}</span>
            {card.body && <span className="hot-card__desc">{card.body}</span>}

            {!!card.swatches?.length && (
              <span className="hot-card__swatches" aria-hidden="true">
                {card.swatches.slice(0, 7).map((hex, index) => (
                  <span key={`${hex}-${index}`} className="hot-card__swatch" style={{ background: hex }} />
                ))}
              </span>
            )}

            {card.progress && (
              <span className="hot-card__progress">
                {/* The bar is the honest shape of "not yet", so it is described
                    to a screen reader as the same sentence a sighted user reads
                    off it, not as a bare percentage. */}
                <span
                  className="hot-card__track"
                  role="progressbar"
                  aria-valuenow={card.progress.value}
                  aria-valuemin={0}
                  aria-valuemax={card.progress.total}
                  aria-label={`${card.progress.value} of ${card.progress.total} days logged`}
                >
                  <span
                    className="hot-card__fill"
                    style={{ inlineSize: `${Math.min(100, (card.progress.value / card.progress.total) * 100)}%` }}
                  />
                </span>
                <span className="hot-card__progress-label">
                  {card.progress.value} / {card.progress.total} days
                </span>
              </span>
            )}
            </span>

            <span className="hot-card__go" aria-hidden="true">
              <ArrowRight size={14} weight="bold" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
