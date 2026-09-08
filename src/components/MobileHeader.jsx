import { useEffect, useRef } from "react";
import { Gear } from "@phosphor-icons/react";

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export function useMobileHeaderScroll(title) {
  const largeRef = useRef(null);
  const barRef = useRef(null);

  useEffect(() => {
    const large = largeRef.current;
    const bar = barRef.current;
    if (!large || !bar) return undefined;

    const paint = () => {
      if (typeof window !== "undefined" && window.innerWidth > 860) {
        large.style.opacity = "";
        bar.style.opacity = "";
        bar.style.transform = "";
        return;
      }
      const t = clamp01((window.scrollY - 8) / 48);
      bar.style.opacity = t.toFixed(3);
      bar.style.transform = `scale(${(0.965 + t * 0.035).toFixed(4)})`;
      large.style.opacity = (1 - t).toFixed(3);
    };

    paint();
    window.addEventListener("scroll", paint, { passive: true });
    window.addEventListener("resize", paint, { passive: true });
    return () => {
      window.removeEventListener("scroll", paint);
      window.removeEventListener("resize", paint);
    };
  }, [title]);

  return { largeRef, barRef };
}

export function MobileCompactBar({ title, barRef }) {
  return (
    <div className="mobile-compactbar" ref={barRef} aria-hidden="true">
      <span className="mobile-compactbar__title">{title}</span>
    </div>
  );
}

export function MobileHeadRow({ title, subtitle, onSettings, badge, largeRef }) {
  return (
    <div className="mobile-headrow">
      <h1 className="mobile-largetitle" ref={largeRef}>
        {title}
      </h1>
      <button
        type="button"
        className="mobile-settings"
        onClick={onSettings}
        aria-label="Open setup guide"
      >
        <Gear size={19} aria-hidden="true" />
        {badge}
      </button>
      {subtitle && <div className="mobile-subtitle">{subtitle}</div>}
    </div>
  );
}

