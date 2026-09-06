import { useEffect, useLayoutEffect, useRef } from "react";
import "./picker.css";

export function Picker({ variants, activeIndex, onSelect, onReplay }) {
  const pickerRef = useRef(null);
  const highlightRef = useRef(null);

  const moveHighlight = () => {
    if (!pickerRef.current || !highlightRef.current) return;
    const items = pickerRef.current.querySelectorAll(".proto-picker-item:not(.proto-picker-replay)");
    const activeEl = items[activeIndex];
    if (activeEl) {
      highlightRef.current.style.width = `${activeEl.offsetWidth}px`;
      highlightRef.current.style.transform = `translateX(${activeEl.offsetLeft}px)`;
    }
  };

  useLayoutEffect(() => {
    moveHighlight();
  }, [activeIndex]);

  useEffect(() => {
    window.addEventListener("resize", moveHighlight);
    // Enable slide only after first paint
    const timer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pickerRef.current?.setAttribute("data-ready", "");
      });
    });
    return () => {
      window.removeEventListener("resize", moveHighlight);
      cancelAnimationFrame(timer);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = Number.parseInt(e.key, 10);
      if (num >= 1 && num <= variants.length) {
        onSelect(num - 1);
      } else if (e.key === "ArrowRight") {
        onSelect((activeIndex + 1) % variants.length);
      } else if (e.key === "ArrowLeft") {
        onSelect((activeIndex - 1 + variants.length) % variants.length);
      } else if (e.key === "r" || e.key === "R") {
        onReplay?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, variants.length, onSelect, onReplay]);

  return (
    <nav className="proto-picker" ref={pickerRef} aria-label="Prototype variants">
      <span className="proto-picker-highlight" ref={highlightRef} aria-hidden="true" />
      {variants.map((variant, index) => (
        <button
          key={variant.name}
          type="button"
          className="proto-picker-item"
          data-active={index === activeIndex ? "" : undefined}
          aria-current={index === activeIndex ? "true" : undefined}
          onClick={() => onSelect(index)}
        >
          {variant.name}
        </button>
      ))}
      <span className="proto-picker-divider" aria-hidden="true" />
      <button
        type="button"
        className="proto-picker-item proto-picker-replay"
        aria-label="Replay animation (R)"
        onClick={onReplay}
      >
        ↻
      </button>
    </nav>
  );
}
