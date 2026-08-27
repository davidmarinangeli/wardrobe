import { OptimizedImage } from "../OptimizedImage.jsx";

/**
 * Full-bleed modeled-photo hero used at the top of item and outfit viewer panels.
 *
 * Renders the photo with the two-layer blur-fade overlay (::before + ::after
 * defined in styles.css .modeled-hero) and a floating frosted-glass name badge.
 *
 * Props
 * ─────
 * src      string – Image URL.
 * alt      string – Alt text for the photo (e.g. "Weekend casual worn by a model").
 * name     string – Displayed in the floating badge.
 */
export function ModeledHero({ src, alt, name }) {
  return (
    <div className="modeled-hero">
      <OptimizedImage
        className="modeled-hero-photo"
        src={src}
        alt={alt}
        sizes="(max-width: 860px) 100vw, 520px"
        breakpoints={[320, 480, 640, 800, 1040, 1280]}
        quality={82}
        priority
      />
      <div className="viewer-heading modeled-heading">
        <div>
          <h2>{name}</h2>
        </div>
      </div>
    </div>
  );
}
