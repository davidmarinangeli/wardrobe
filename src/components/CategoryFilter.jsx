import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FunnelSimple } from "@phosphor-icons/react";

/**
 * The "Filter" button at the end of a category track, with a small menu of
 * filters that combine with whichever category is selected ("Matches my
 * colors"). Those filters are a different kind of thing from the categories,
 * so they live behind one button instead of posing as one more segment.
 *
 * The menu is portalled to <body> and positioned against the button: the
 * track it sits in scrolls sideways, which would clip anything absolutely
 * positioned inside it.
 *
 * Props
 * options   [{ id, label, description, swatch, checked, onToggle }]
 * label     string – the button's text. Defaults to "Filter".
 */
export function CategoryFilter({ options, label = "Filter" }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const activeCount = options.filter((option) => option.checked).length;

  const close = useCallback((restoreFocus) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // Anchored under the button, right edges aligned, kept inside the viewport.
  const measure = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gutter = 12;
    const right = Math.max(gutter, window.innerWidth - rect.right);
    setPlace({ top: rect.bottom + 8, right });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector('[role="menuitemcheckbox"]')?.focus({ preventScroll: true });
    const onPointer = (event) => {
      if (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target)) return;
      close(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") {
        close(false);
      }
    };
    const onMove = () => close(false);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const onMenuKeyDown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitemcheckbox"]') || [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`category-filter${activeCount ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FunnelSimple size={16} weight="regular" aria-hidden="true" />
        {label}
        {activeCount > 0 && (
          <span className="category-filter__count">
            {activeCount}
            <span className="sr-only">{activeCount === 1 ? " filter on" : " filters on"}</span>
          </span>
        )}
      </button>
      {open && place && createPortal(
        <div
          ref={menuRef}
          className="filter-menu"
          role="menu"
          aria-label={label}
          style={{ top: place.top, right: place.right }}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={option.checked}
              className="filter-menu__item"
              onClick={() => option.onToggle()}
            >
              {option.swatch && <span className="filter-menu__swatch" style={{ backgroundColor: option.swatch }} aria-hidden="true" />}
              <span className="filter-menu__text">
                <span className="filter-menu__label">{option.label}</span>
                {option.description && <span className="filter-menu__description">{option.description}</span>}
              </span>
              <span className="filter-menu__check" aria-hidden="true">
                {option.checked && <Check size={16} weight="bold" />}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
